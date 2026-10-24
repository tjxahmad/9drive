import { GetObjectCommand } from '@aws-sdk/client-s3'
import type { ConnectedAccount, File, Prisma } from '@prisma/client'
import { ZipArchive } from 'archiver'
import type { Response } from 'express'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { prisma } from '../../config/prisma.js'
import { contentDisposition } from '../../utils/content-disposition.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { getAuthedGoogleClient } from '../google/google.service.js'
import { createS3Client, getS3ConfigForAccount } from '../s3/s3.service.js'
import { isFolderBlocked, type LockState } from '../folders/folder-lock.js'
import { googleDownloadExportMimeTypes, normalizeHeaders, withExtension } from './stream-google-file.js'

type FileWithAccount = File & { connectedAccount: ConnectedAccount }
export type ZipEntry = { file: FileWithAccount; path: string }

// A download link lives long enough for the browser to resume a dropped single-file download; a ZIP can't resume.
const TOKEN_TTL_MS = { file: 6 * 60 * 60_000, zip: 60 * 60_000 }

type TokenEntry = { id: string; path: string }

// entries: the files, with their path inside the ZIP (for a single file, just its name).
export async function createDownloadToken(userId: string, kind: 'file' | 'zip', entries: TokenEntry[], name: string, folderId?: string | null) {
  await prisma.downloadToken.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } })
  const token = randomToken(32)
  await prisma.downloadToken.create({
    data: { userId, kind, tokenHash: hashToken(token), fileIds: entries as unknown as Prisma.InputJsonValue, folderId: folderId ?? null, name, expiresAt: new Date(Date.now() + TOKEN_TTL_MS[kind]) },
  })
  return token
}

export async function findDownloadToken(token: string, kind: 'file' | 'zip') {
  const record = await prisma.downloadToken.findFirst({ where: { tokenHash: hashToken(token), kind, expiresAt: { gt: new Date() } } })
  if (!record) return null
  const entries = (Array.isArray(record.fileIds) ? record.fileIds : []).filter((entry): entry is TokenEntry =>
    typeof entry === 'object' && entry !== null && typeof (entry as TokenEntry).id === 'string' && typeof (entry as TokenEntry).path === 'string')
  return { ...record, entries }
}

// Whole-file read stream from the file's storage (Google files in Google's own formats are exported).
async function openProviderFileStream(file: FileWithAccount, signal: AbortSignal) {
  if (file.provider === 's3') {
    const config = await getS3ConfigForAccount(file.connectedAccountId)
    const response = await createS3Client(config).send(new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId }), { abortSignal: signal })
    if (!response.Body) throw new Error('Empty file')
    return { stream: response.Body as Readable, fileName: file.name }
  }
  const auth = await getAuthedGoogleClient(file.connectedAccount)
  const headers = normalizeHeaders(await auth.getRequestHeaders())
  const exportTarget = googleDownloadExportMimeTypes[file.mimeType]
  const url = exportTarget
    ? `https://www.googleapis.com/drive/v3/files/${file.providerFileId}/export?mimeType=${encodeURIComponent(exportTarget.mimeType)}`
    : `https://www.googleapis.com/drive/v3/files/${file.providerFileId}?alt=media`
  const response = await fetch(url, { headers, signal })
  if (!response.ok || !response.body) throw new Error(`Google returned ${response.status}`)
  return { stream: Readable.fromWeb(response.body as unknown as NodeReadableStream), fileName: exportTarget ? withExtension(file.name, exportTarget.extension) : file.name }
}

// Photos, videos and archives are already compressed: storing them as they are is much faster and just as small.
function isCompressed(mimeType: string) {
  return /^(image|video|audio)\//.test(mimeType) || /(zip|gzip|x-7z|rar|x-tar|x-bzip|x-xz)/.test(mimeType)
}

export function safeSegment(name: string) {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
  return !cleaned || cleaned === '.' || cleaned === '..' ? '_' : cleaned
}

// "a.jpg", "a (2).jpg", ... so two files with the same name in one folder don't overwrite each other.
export function uniquePath(path: string, used: Set<string>) {
  let candidate = path
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  const [stem, extension] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, '']
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${extension}`
  used.add(candidate.toLowerCase())
  return candidate
}

// Streams a ZIP to the browser one file at a time (each file is fetched only when its turn comes), so even
// several GB never sit in memory. Files over 4 GB / ZIPs over 4 GB use ZIP64 automatically.
export async function streamZip(res: Response, entries: ZipEntry[], zipName: string) {
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', contentDisposition('attachment', zipName))
  res.setHeader('Cache-Control', 'no-store')

  const controller = new AbortController()
  let closed = false
  const archive = new ZipArchive({ zlib: { level: 6 } })
  res.on('close', () => {
    if (res.writableFinished) return
    closed = true
    controller.abort()
    archive.abort()
  })
  archive.on('error', (error) => {
    console.error('[zip] archive failed:', error.message)
    closed = true
    controller.abort()
    res.destroy(error)
  })
  archive.pipe(res)

  // Resolves once the archive has written this entry, so the next file is only fetched after that.
  const appendAndWait = (source: Readable | string, name: string, store: boolean) => new Promise<void>((resolve, reject) => {
    if (typeof source !== 'string') source.on('error', reject)
    archive.once('entry', () => resolve())
    archive.append(source, { name, store })
  })

  const used = new Set<string>()
  for (const entry of entries) {
    if (closed) return
    try {
      const { stream, fileName } = await openProviderFileStream(entry.file, controller.signal)
      const slash = entry.path.lastIndexOf('/')
      await appendAndWait(stream, uniquePath(`${slash >= 0 ? entry.path.slice(0, slash + 1) : ''}${safeSegment(fileName)}`, used), isCompressed(entry.file.mimeType))
    } catch (error) {
      if (closed) return
      // Leave a note in the ZIP instead of silently dropping the file.
      console.error('[zip] file skipped:', error instanceof Error ? error.message : error)
      await appendAndWait(`This file could not be downloaded: ${entry.file.name}\n`, uniquePath(`${entry.path}.ERROR.txt`, used), false).catch(() => undefined)
    }
  }
  if (!closed) await archive.finalize()
}

// Every active file in a folder and its subfolders, with its path inside the download ("Trip/Day 1/a.jpg").
// Subfolders that are still locked are left out and counted.
export async function collectFolderFiles(state: LockState, userId: string, rootId: string) {
  const root = state.folders.get(rootId)
  if (!root || root.deletedAt) return null
  const children = new Map<string, string[]>()
  for (const folder of state.folders.values()) {
    if (folder.deletedAt || !folder.parentId) continue
    children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder.id])
  }
  const paths = new Map<string, string>([[rootId, safeSegment(root.name)]])
  const queue = [rootId]
  let lockedSubfolders = 0
  while (queue.length) {
    const id = queue.shift()!
    for (const childId of children.get(id) ?? []) {
      if (isFolderBlocked(state, childId)) { lockedSubfolders++; continue }
      paths.set(childId, `${paths.get(id)}/${safeSegment(state.folders.get(childId)!.name)}`)
      queue.push(childId)
    }
  }
  const files = await prisma.file.findMany({
    where: { userId, status: 'active', folderId: { in: [...paths.keys()] } },
    include: { connectedAccount: true },
    orderBy: { name: 'asc' },
  })
  const used = new Set<string>()
  const entries = files.map((file) => ({ file, path: uniquePath(`${paths.get(file.folderId!)}/${safeSegment(file.name)}`, used) }))
  return { root, entries, lockedSubfolders }
}
