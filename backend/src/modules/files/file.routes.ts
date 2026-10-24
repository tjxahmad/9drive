import { Router, type Response } from 'express'
import { google } from 'googleapis'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { getAuthedGoogleClient, syncGoogleAppFolderFiles, syncGoogleQuota } from '../google/google.service.js'
import { deleteS3Object, syncS3Quota } from '../s3/s3.service.js'
import { streamProviderFile } from './stream-file.js'
import { normalizeHeaders } from './stream-google-file.js'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { createAuditLog } from '../../utils/audit.js'
import { getLockState, isFolderBlocked, nearestExistingFolder, openFilesFilter, sendFolderLocked, type LockState } from '../folders/folder-lock.js'
import { createDownloadToken, findDownloadToken, safeSegment, streamZip } from './downloads.js'



export const fileRouter = Router()

// Links opened by <video>/<img> tags and by browser downloads carry their own token: those requests can't send the
// login header. Each token opens only the file(s) it was made for.
fileRouter.get('/preview/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token)
    const preview = await prisma.filePreviewToken.findFirst({
      where: { tokenHash: hashToken(token), expiresAt: { gt: new Date() } },
      include: { file: { include: { connectedAccount: true } } },
    })
    if (!preview || preview.file.status !== 'active') return res.status(404).json({ code: 'PREVIEW_NOT_FOUND', message: 'Preview token not found.' })
    return streamProviderFile(preview.file, req.headers.range, res, { disposition: 'inline' })
  } catch (error) {
    return next(error)
  }
})

const expiredDownload = (res: Response) => res.status(404).json({ code: 'DOWNLOAD_NOT_FOUND', message: 'This download link has expired. Start the download again.' })

fileRouter.get('/download/:token', async (req, res, next) => {
  try {
    const record = await findDownloadToken(String(req.params.token), 'file')
    const file = record?.entries[0] ? await prisma.file.findFirst({ where: { id: record.entries[0].id, userId: record.userId, status: 'active' }, include: { connectedAccount: true } }) : null
    if (!record || !file) return expiredDownload(res)
    return await streamProviderFile(file, req.headers.range, res, { disposition: 'attachment' })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/zip/:token', async (req, res, next) => {
  try {
    const record = await findDownloadToken(String(req.params.token), 'zip')
    if (!record) return expiredDownload(res)
    const files = await prisma.file.findMany({ where: { id: { in: record.entries.map((entry) => entry.id) }, userId: record.userId, status: 'active' }, include: { connectedAccount: true } })
    const byId = new Map(files.map((file) => [file.id, file]))
    const entries = record.entries.flatMap((entry) => {
      const file = byId.get(entry.id)
      return file ? [{ file, path: entry.path }] : []
    })
    return await streamZip(res, entries, record.name)
  } catch (error) {
    if (res.headersSent) return res.destroy()
    return next(error)
  }
})

fileRouter.use(requireAuth)

// The user's file by :id, unless it is inside a locked folder. Sends the 404/423 itself and returns null.
async function findOpenFile(req: AuthRequest, res: Response, state: LockState, activeOnly = false) {
  const file = await prisma.file.findFirst({ where: { id: String(req.params.id), userId: req.user!.id, ...(activeOnly ? { status: 'active' } : {}) }, include: { connectedAccount: true } })
  if (!file) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Not found.' })
    return null
  }
  if (isFolderBlocked(state, file.folderId)) {
    sendFolderLocked(res, state, file.folderId)
    return null
  }
  return file
}

// What the Activity page shows for a file; folderId lets it hide the name while the folder is locked.
function fileLogDetails(file: { name: string; sizeBytes: bigint; folderId: string | null }) {
  return { name: file.name, sizeBytes: file.sizeBytes.toString(), folderId: file.folderId }
}

fileRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const query = z.object({
      folderId: z.string().optional(),
      q: z.string().trim().max(255).optional(),
      kind: z.enum(['image', 'video', 'pdf', 'doc', 'archive']).optional(),
      accountId: z.string().optional(),
      minSize: z.coerce.number().optional(),
      maxSize: z.coerce.number().optional(),
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional()
    }).parse(req.query)

    const state = await getLockState(req)
    if (query.folderId && isFolderBlocked(state, query.folderId)) return sendFolderLocked(res, state, query.folderId)

    const typeFilters: Record<string, string[]> = {
      image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
      video: ['video/mp4', 'video/mpeg', 'video/ogg', 'video/quicktime', 'video/webm'],
      pdf: ['application/pdf'],
      doc: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'],
      archive: ['application/zip', 'application/x-rar-compressed', 'application/x-tar', 'application/x-7z-compressed']
    }

    const where: any = {
      userId: req.user!.id,
      status: 'active',
      // Files inside locked folders never show up in lists or search.
      ...openFilesFilter(state),
      ...(query.folderId ? { folderId: query.folderId } : {}),
      ...(query.q ? { name: { contains: query.q } } : {}),
      ...(query.accountId ? { connectedAccountId: query.accountId } : {}),
      ...(query.kind ? { mimeType: { in: typeFilters[query.kind] || [] } } : {}),
      ...(query.minSize !== undefined || query.maxSize !== undefined ? {
        sizeBytes: {
          ...(query.minSize !== undefined ? { gte: BigInt(query.minSize) } : {}),
          ...(query.maxSize !== undefined ? { lte: BigInt(query.maxSize) } : {})
        }
      } : {}),
      ...(query.startDate || query.endDate ? {
        createdAt: {
          ...(query.startDate ? { gte: new Date(query.startDate) } : {}),
          ...(query.endDate ? { lte: new Date(query.endDate) } : {})
        }
      } : {})
    }

    const files = await prisma.file.findMany({
      where,
      include: {
        connectedAccount: { select: { id: true, email: true, provider: true } },
        folder: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
    return res.json({ files: files.map((file) => ({ ...file, sizeBytes: file.sizeBytes.toString() })) })
  } catch (error) {
    return next(error)
  }
})

const batchFileSchema = z.object({ fileIds: z.array(z.string().min(1)).min(1).max(100) })

fileRouter.patch('/batch', async (req: AuthRequest, res, next) => {
  try {
    const body = batchFileSchema.extend({ folderId: z.string().nullable().optional() }).parse(req.body)
    const state = await getLockState(req)
    if (body.folderId) {
      await prisma.folder.findFirstOrThrow({ where: { id: body.folderId, userId: req.user!.id, deletedAt: null } })
      if (isFolderBlocked(state, body.folderId)) return sendFolderLocked(res, state, body.folderId)
    }
    const result = await prisma.file.updateMany({ where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'active', ...openFilesFilter(state) }, data: { folderId: body.folderId ?? null } })
    await createAuditLog(req.user!.id, 'MOVE_FILES', 'file', undefined, { count: result.count, folderId: body.folderId })
    return res.json({ status: 'ok', moved: result.count })
  } catch (error) {
    return next(error)
  }
})

fileRouter.delete('/batch', async (req: AuthRequest, res, next) => {
  try {
    const body = batchFileSchema.parse(req.body)
    const state = await getLockState(req)
    const where = { id: { in: body.fileIds }, userId: req.user!.id, status: 'active', ...openFilesFilter(state) }
    const files = await prisma.file.findMany({ where })
    const result = await prisma.file.updateMany({
      where,
      data: { status: 'deleted', deletedAt: new Date() }
    })
    for (const f of files) {
      await createAuditLog(req.user!.id, 'TRASH_FILE', 'file', f.id, fileLogDetails(f))
    }
    return res.json({ status: 'ok', deleted: result.count })
  } catch (error) {
    return next(error)
  }
})

// Files from locked folders stay in the Recycle Bin but are shown without name or details (and not found by search).
fileRouter.get('/trash', async (req: AuthRequest, res, next) => {
  try {
    const query = z.object({ q: z.string().trim().max(255).optional() }).parse(req.query)
    const state = await getLockState(req)
    const files = await prisma.file.findMany({
      where: {
        userId: req.user!.id,
        status: 'deleted',
        ...(query.q ? { name: { contains: query.q }, ...openFilesFilter(state) } : {})
      },
      include: {
        connectedAccount: { select: { id: true, email: true, provider: true } },
        folder: { select: { id: true, name: true } }
      },
      orderBy: { deletedAt: 'desc' }
    })
    return res.json({
      files: files.map((file) => isFolderBlocked(state, file.folderId)
        ? { id: file.id, name: 'Locked file', mimeType: 'application/octet-stream', sizeBytes: file.sizeBytes.toString(), createdAt: file.createdAt, deletedAt: file.deletedAt, status: file.status, provider: file.provider, connectedAccount: file.connectedAccount, folder: null, folderId: null, locked: true }
        : { ...file, sizeBytes: file.sizeBytes.toString() })
    })
  } catch (error) {
    return next(error)
  }
})

fileRouter.post('/batch/restore', async (req: AuthRequest, res, next) => {
  try {
    const body = batchFileSchema.parse(req.body)
    const state = await getLockState(req)
    const files = await prisma.file.findMany({ where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'deleted' } })
    for (const f of files) {
      // A file whose folder was deleted goes back to the nearest folder that still exists (or the top level), so a
      // file from a locked folder stays inside that lock.
      await prisma.file.update({ where: { id: f.id }, data: { status: 'active', deletedAt: null, folderId: nearestExistingFolder(state, f.folderId) } })
      await createAuditLog(req.user!.id, 'RESTORE_FILE', 'file', f.id, fileLogDetails(f))
    }
    return res.json({ status: 'ok', restored: files.length })
  } catch (error) {
    return next(error)
  }
})

fileRouter.delete('/batch/permanent', async (req: AuthRequest, res, next) => {
  try {
    const body = batchFileSchema.parse(req.body)
    const files = await prisma.file.findMany({
      where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'deleted' },
      include: { connectedAccount: true }
    })
    const deletedIds: string[] = []
    const syncedAccountIds = new Set<string>()
    const failed: Array<{ fileId: string; message: string }> = []

    for (const file of files) {
      try {
        if (file.provider === 's3') {
          await deleteS3Object(file)
        } else {
          const auth = await getAuthedGoogleClient(file.connectedAccount)
          const drive = google.drive({ version: 'v3', auth })
          await drive.files.delete({ fileId: file.providerFileId })
        }
        deletedIds.push(file.id)
        syncedAccountIds.add(file.connectedAccountId)
        await createAuditLog(req.user!.id, 'PERMANENT_DELETE_FILE', 'file', file.id, fileLogDetails(file))
      } catch (error) {
        failed.push({ fileId: file.id, message: error instanceof Error ? error.message : 'Delete failed' })
      }
    }

    if (deletedIds.length > 0) {
      await prisma.file.deleteMany({
        where: { id: { in: deletedIds }, userId: req.user!.id }
      })
    }

    for (const accountId of syncedAccountIds) {
      const account = files.find((file) => file.connectedAccountId === accountId)?.connectedAccount
      if (account?.provider === 's3') {
        await syncS3Quota(accountId).catch(() => undefined)
      } else {
        await syncGoogleQuota(accountId).catch(() => undefined)
      }
    }

    if (deletedIds.length === 0 && failed.length > 0) {
      return res.status(400).json({ code: 'FILES_DELETE_FAILED', message: 'No files were permanently deleted.', deleted: 0, failed })
    }
    return res.json({ status: 'ok', deleted: deletedIds.length, failed })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/shared-links', async (req: AuthRequest, res, next) => {
  try {
    const state = await getLockState(req)
    const shares = await prisma.fileShare.findMany({
      where: { userId: req.user!.id, enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      include: { file: { include: { connectedAccount: { select: { email: true, provider: true } }, folder: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: 'desc' },
    })
    return res.json({
      shares: shares.filter((share) => share.file.status === 'active' && !isFolderBlocked(state, share.file.folderId)).map((share) => {
        const url = share.token ? `${env.FRONTEND_URL}/public/files/${share.token}` : null
        return {
          id: share.id,
          url,
          createdAt: share.createdAt.toISOString(),
          expiresAt: share.expiresAt?.toISOString() ?? null,
          file: { ...share.file, sizeBytes: share.file.sizeBytes.toString() },
        }
      })
    })
  } catch (error) {
    return next(error)
  }
})

fileRouter.post('/sync-google', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ connectedAccountId: z.string().min(1).optional() }).parse(req.body ?? {})
    const accounts = await prisma.connectedAccount.findMany({
      where: { userId: req.user!.id, provider: 'google_drive', status: 'connected', ...(body.connectedAccountId ? { id: body.connectedAccountId } : {}) },
      select: { id: true },
    })

    const results = []
    for (const account of accounts) results.push(await syncGoogleAppFolderFiles(account.id, req.user!.id))

    return res.json({
      status: 'ok',
      results,
    })
  } catch (error) {
    return next(error)
  }
})

// One browser download link for the selected files as a ZIP.
fileRouter.post('/zip-link', async (req: AuthRequest, res, next) => {
  try {
    const body = batchFileSchema.parse(req.body)
    const state = await getLockState(req)
    const files = await prisma.file.findMany({ where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'active', ...openFilesFilter(state) }, orderBy: { name: 'asc' } })
    if (files.length === 0) return res.status(404).json({ code: 'FILES_NOT_FOUND', message: 'No files found.' })
    const token = await createDownloadToken(req.user!.id, 'zip', files.map((file) => ({ id: file.id, path: safeSegment(file.name) })), '9drive-files.zip')
    await createAuditLog(req.user!.id, 'DOWNLOAD_ZIP', 'file', undefined, {
      count: files.length,
      sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0n).toString(),
      names: files.slice(0, 10).map((file) => file.name),
      folderIds: [...new Set(files.map((file) => file.folderId).filter(Boolean))],
    })
    return res.status(201).json({ path: `/files/zip/${token}` })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const state = await getLockState(req)
    const found = await findOpenFile(req, res, state)
    if (!found) return
    const file = await prisma.file.findFirstOrThrow({ where: { id: found.id }, include: { connectedAccount: { select: { id: true, email: true, provider: true } }, folder: { select: { id: true, name: true } } } })
    return res.json({ file: { ...file, sizeBytes: file.sizeBytes.toString() } })
  } catch (error) {
    return next(error)
  }
})

fileRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ name: z.string().min(1).max(255).optional(), folderId: z.string().nullable().optional() }).parse(req.body)
    const state = await getLockState(req)
    const file = await findOpenFile(req, res, state)
    if (!file) return
    if (body.folderId) {
      await prisma.folder.findFirstOrThrow({ where: { id: body.folderId, userId: req.user!.id, deletedAt: null } })
      if (isFolderBlocked(state, body.folderId)) return sendFolderLocked(res, state, body.folderId)
    }
    const drive = file.provider === 's3' ? null : google.drive({ version: 'v3', auth: await getAuthedGoogleClient(file.connectedAccount) })
    if (body.name && drive) await drive.files.update({ fileId: file.providerFileId, requestBody: { name: body.name } })
    const updated = await prisma.file.update({ where: { id: file.id }, data: { ...(body.name ? { name: body.name } : {}), ...(body.folderId !== undefined ? { folderId: body.folderId } : {}) }, include: { connectedAccount: { select: { id: true, email: true, provider: true } }, folder: { select: { id: true, name: true } } } })
    await createAuditLog(req.user!.id, 'UPDATE_FILE', 'file', updated.id, { ...fileLogDetails(updated), updates: body })
    return res.json({ file: { ...updated, sizeBytes: updated.sizeBytes.toString() } })
  } catch (error) {
    return next(error)
  }
})

// Public share links and public Google Drive permissions are disabled: only the owner can read or write files.
fileRouter.post('/:id/share', (_req, res) => {
  return res.status(403).json({ code: 'SHARING_DISABLED', message: 'Public share links are disabled. Only the owner can access files.' })
})

fileRouter.delete('/:id/share', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    await prisma.fileShare.updateMany({ where: { fileId, userId: req.user!.id, enabled: true }, data: { enabled: false } })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

fileRouter.post('/:id/preview-token', async (req: AuthRequest, res, next) => {
  try {
    const state = await getLockState(req)
    const file = await findOpenFile(req, res, state, true)
    if (!file) return
    const token = randomToken(32)
    // Long enough to watch (and seek in) a long video; the token only opens this one file.
    await prisma.filePreviewToken.create({ data: { fileId: file.id, userId: req.user!.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 4 * 60 * 60_000) } })
    await createAuditLog(req.user!.id, 'PREVIEW_FILE', 'file', file.id, fileLogDetails(file))
    const path = `/files/preview/${token}`
    return res.status(201).json({ path, url: `${req.protocol}://${req.get('host')}${path}` })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/:id/view-url', async (req: AuthRequest, res, next) => {
  try {
    const state = await getLockState(req)
    const file = await findOpenFile(req, res, state)
    if (!file) return
    if (file.provider === 's3') return res.json({ url: null })
    const auth = await getAuthedGoogleClient(file.connectedAccount)
    const drive = google.drive({ version: 'v3', auth })
    // The Drive link stays private: it only opens for the Google account that owns the file.
    const metadata = await drive.files.get({ fileId: file.providerFileId, fields: 'webViewLink,webContentLink' })
    // Office files are previewed through this link (?preview=1); copying the link is not a preview.
    if (req.query.preview === '1') await createAuditLog(req.user!.id, 'PREVIEW_FILE', 'file', file.id, fileLogDetails(file))
    return res.json({ url: metadata.data.webViewLink ?? metadata.data.webContentLink })
  } catch (error) {
    return next(error)
  }
})

const MAX_S3_THUMBNAIL_SOURCE_BYTES = 8n * 1024n * 1024n

// Small preview image for photos and videos (used by file and folder cards).
fileRouter.get('/:id/thumbnail', async (req: AuthRequest, res, next) => {
  try {
    const state = await getLockState(req)
    const file = await findOpenFile(req, res, state, true)
    if (!file) return
    const noThumbnail = () => res.status(404).json({ code: 'NO_THUMBNAIL', message: 'No thumbnail for this file.' })
    if (!file.mimeType.startsWith('image/') && !file.mimeType.startsWith('video/')) return noThumbnail()

    if (file.provider === 's3') {
      // S3/R2 has no thumbnail service: small images are sent as they are, others show an icon.
      if (!file.mimeType.startsWith('image/') || file.sizeBytes > MAX_S3_THUMBNAIL_SOURCE_BYTES) return noThumbnail()
      res.setHeader('Cache-Control', 'private, max-age=3600')
      return streamProviderFile(file, undefined, res, { disposition: 'inline' })
    }

    const auth = await getAuthedGoogleClient(file.connectedAccount)
    const drive = google.drive({ version: 'v3', auth })
    const metadata = await drive.files.get({ fileId: file.providerFileId, fields: 'thumbnailLink' })
    const link = metadata.data.thumbnailLink
    if (!link) return noThumbnail()
    // Google's short-lived thumbnail link; ask for a 400px version.
    const sizedLink = link.replace(/=s\d+$/, '=s400')
    let response = await fetch(sizedLink)
    if (response.status === 401 || response.status === 403) response = await fetch(sizedLink, { headers: normalizeHeaders(await auth.getRequestHeaders()) })
    if (!response.ok || !response.body) return noThumbnail()
    res.setHeader('Content-Type', response.headers.get('content-type') ?? 'image/jpeg')
    res.setHeader('Cache-Control', 'private, max-age=3600')
    await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), res).catch(() => undefined)
  } catch (error) {
    return next(error)
  }
})

// Streams the file to an app request that sends the login header (used when saving a whole folder to disk).
fileRouter.get('/:id/download', async (req: AuthRequest, res, next) => {
  try {
    const state = await getLockState(req)
    const file = await findOpenFile(req, res, state)
    if (!file) return
    return await streamProviderFile(file, req.headers.range, res, { disposition: 'attachment' })
  } catch (error) {
    return next(error)
  }
})

// A link the browser downloads by itself: the file goes straight to disk with the browser's own progress bar,
// instead of being collected in page memory first (which looked like nothing happened for minutes on big videos).
fileRouter.post('/:id/download-link', async (req: AuthRequest, res, next) => {
  try {
    const state = await getLockState(req)
    const file = await findOpenFile(req, res, state, true)
    if (!file) return
    const token = await createDownloadToken(req.user!.id, 'file', [{ id: file.id, path: file.name }], file.name)
    await createAuditLog(req.user!.id, 'DOWNLOAD_FILE', 'file', file.id, fileLogDetails(file))
    return res.status(201).json({ path: `/files/download/${token}` })
  } catch (error) {
    return next(error)
  }
})

fileRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const state = await getLockState(req)
    const file = await findOpenFile(req, res, state, true)
    if (!file) return
    await prisma.file.update({ where: { id: file.id }, data: { status: 'deleted', deletedAt: new Date() } })
    await createAuditLog(req.user!.id, 'TRASH_FILE', 'file', file.id, fileLogDetails(file))
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

// ZIP of the selected files for API clients that send the login header (the app uses /zip-link).
fileRouter.post('/batch-download', async (req: AuthRequest, res, next) => {
  try {
    const body = batchFileSchema.parse(req.body)
    const state = await getLockState(req)
    const files = await prisma.file.findMany({
      where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'active', ...openFilesFilter(state) },
      include: { connectedAccount: true }
    })
    if (files.length === 0) return res.status(404).json({ code: 'FILES_NOT_FOUND', message: 'No files found.' })
    await createAuditLog(req.user!.id, 'DOWNLOAD_ZIP', 'file', undefined, { count: files.length, names: files.slice(0, 10).map((file) => file.name), folderIds: [...new Set(files.map((file) => file.folderId).filter(Boolean))] })
    return await streamZip(res, files.map((file) => ({ file, path: safeSegment(file.name) })), '9drive-download.zip')
  } catch (error) {
    if (res.headersSent) return res.destroy()
    return next(error)
  }
})
