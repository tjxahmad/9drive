import Busboy from 'busboy'
import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { Readable } from 'stream'
import { z } from 'zod'
import { google } from 'googleapis'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { ensureGoogleAppFolder, getAuthedGoogleClient, syncGoogleQuota } from '../google/google.service.js'
import { abortS3MultipartUpload, buildS3ObjectKey, completeS3MultipartUpload, createS3MultipartUpload, deleteS3ObjectByKey, getS3ConfigForAccount, listS3UploadedParts, S3_PART_SIZE, syncS3Quota, uploadS3Object, uploadS3Part } from '../s3/s3.service.js'
import { createAuditLog } from '../../utils/audit.js'

export const uploadRouter = Router()

type UploadMeta = { fieldName: string; fileName: string; mimeType: string; sizeBytes: bigint; folderId?: string }
type RoutingMode = 'balanced' | 'most_available' | 'round_robin' | 'priority'

function logUpload(message: string, metadata?: Record<string, unknown>) {
  console.info('[upload]', message, metadata ?? '')
}

function syncQuotaInBackground(accountId: string, sessionId: string) {
  logUpload('quota sync started', { accountId, sessionId })
  syncGoogleQuota(accountId)
    .then(() => logUpload('quota sync completed', { accountId, sessionId }))
    .catch((error) => logUpload('quota sync failed', { accountId, sessionId, message: error instanceof Error ? error.message : 'Unknown error' }))
}

const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000
const RECENT_UPLOAD_MS = 15 * 60 * 1000

// Bytes that use (or will soon use) space but may not show in an account's quota yet, per account: uploads in
// progress (S3/R2 parts are already billed storage) and uploads finished in the last 15 minutes (Google updates its
// storage numbers with a delay). Reserving them keeps back-to-back uploads spread across accounts.
// S3/R2 uploads abandoned for 24 hours are aborted.
async function pendingUploadBytes(userId: string) {
  const staleBefore = new Date(Date.now() - STALE_UPLOAD_MS)
  const sessions = await prisma.uploadSession.findMany({
    where: {
      userId,
      OR: [
        { status: 'uploading', createdAt: { gt: staleBefore } },
        { status: 'uploading', s3UploadId: { not: null } },
        // Only Google lags; S3/R2 usage is re-read right after each upload, so counting these again would double them.
        { status: 'completed', completedAt: { gt: new Date(Date.now() - RECENT_UPLOAD_MS) }, targetConnectedAccount: { is: { provider: 'google_drive' } } },
      ],
    },
  })
  const pending = new Map<string, bigint>()
  for (const session of sessions) {
    if (!session.targetConnectedAccountId) continue
    const stale = session.status === 'uploading' && session.createdAt < staleBefore
    if (stale && session.s3UploadId) {
      try {
        const config = await getS3ConfigForAccount(session.targetConnectedAccountId, userId)
        await abortS3MultipartUpload(config, buildS3ObjectKey(config, userId, session.id, session.fileName), session.s3UploadId)
      } catch (error) {
        logUpload('stale multipart abort failed', { sessionId: session.id, message: error instanceof Error ? error.message : 'Unknown error' })
      }
      await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'Abandoned upload aborted.' } })
      continue
    }
    if (stale) continue
    pending.set(session.targetConnectedAccountId, (pending.get(session.targetConnectedAccountId) ?? 0n) + session.sizeBytes)
  }
  return pending
}

// Reads one upload chunk into memory, refusing bodies larger than the declared size.
async function readChunk(req: AuthRequest, maxBytes: number) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('Chunk is larger than its Content-Range.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function normalizePriorityAccountIds(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function byPriority<T extends { account: { id: string; createdAt: Date } }>(items: T[], priorityAccountIds: string[]) {
  const order = new Map(priorityAccountIds.map((id, index) => [id, index]))
  return [...items].sort((a, b) => {
    const aOrder = order.get(a.account.id)
    const bOrder = order.get(b.account.id)
    if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder
    if (aOrder !== undefined) return -1
    if (bOrder !== undefined) return 1
    return a.account.createdAt.getTime() - b.account.createdAt.getTime()
  })
}

// targetAccountId: the user picked this account explicitly, so use it or fail. Otherwise the routing policy decides;
// folders are virtual, so a folder's files can be spread over any accounts.
async function selectAccount(userId: string, sizeBytes: bigint, reservedBytesByAccount = new Map<string, bigint>(), targetAccountId?: string | null) {
  const accounts = await prisma.connectedAccount.findMany({
    where: { userId, provider: { in: ['google_drive', 's3'] }, status: 'connected', ...(targetAccountId ? { id: targetAccountId } : {}) },
    include: { storageAccount: true },
  })

  const stale = accounts.filter((account) => !account.storageAccount?.lastSyncedAt || account.storageAccount.lastSyncedAt.getTime() < Date.now() - 5 * 60_000)
  await Promise.allSettled(stale.map(async (account) => {
    try {
      if (account.provider === 's3') {
        await syncS3Quota(account.id)
      } else {
        await syncGoogleQuota(account.id)
      }
    } catch (err: any) {
      console.error(`[upload] failed to sync quota for account ${account.email} (${account.id}):`, err.message || err)
      await prisma.connectedAccount.update({
        where: { id: account.id },
        data: { lastError: err.message || 'Quota sync failed' }
      }).catch(() => undefined)
    }
  }))

  const fresh = await prisma.connectedAccount.findMany({
    where: { userId, provider: { in: ['google_drive', 's3'] }, status: 'connected' },
    include: { storageAccount: true },
  })

  const eligible = fresh
    .map((account) => ({ account, availableBytes: account.storageAccount?.availableBytes === null || account.storageAccount?.availableBytes === undefined ? null : account.storageAccount.availableBytes - (reservedBytesByAccount.get(account.id) ?? 0n) }))
    .filter(({ availableBytes }) => availableBytes === null || availableBytes >= sizeBytes)

  if (eligible.length === 0) return null

  if (targetAccountId) {
    const target = eligible.find(e => e.account.id === targetAccountId)
    return target?.account ?? null
  }

  const policy = await prisma.uploadRoutingPolicy.upsert({ where: { userId }, create: { userId, mode: 'balanced', priorityAccountIds: [] }, update: {} })
  const mode = (['balanced', 'most_available', 'round_robin', 'priority'].includes(policy.mode) ? policy.mode : 'balanced') as RoutingMode
  const priorityAccountIds = normalizePriorityAccountIds(policy.priorityAccountIds)

  if (mode === 'balanced') {
    // Fill accounts evenly: pick the one with the lowest % used (e.g. 10% full before 30% full).
    // Accounts without a size limit go last; ties go to the one with more free space.
    const usedFraction = (item: (typeof eligible)[number]) => {
      const total = item.account.storageAccount?.totalBytes
      if (!total || item.availableBytes === null) return Number.POSITIVE_INFINITY
      return Number(total - item.availableBytes) / Number(total)
    }
    return [...eligible].sort((a, b) => {
      const difference = usedFraction(a) - usedFraction(b)
      if (Number.isFinite(difference) && difference !== 0) return difference
      if (!Number.isFinite(usedFraction(a)) && Number.isFinite(usedFraction(b))) return 1
      if (Number.isFinite(usedFraction(a)) && !Number.isFinite(usedFraction(b))) return -1
      return Number((b.availableBytes ?? 0n) - (a.availableBytes ?? 0n))
    })[0]?.account
  }

  if (mode === 'priority') return byPriority(eligible, priorityAccountIds)[0]?.account ?? null

  if (mode === 'round_robin') {
    const ordered = byPriority(eligible, priorityAccountIds)
    const selected = ordered[policy.roundRobinCursor % ordered.length]?.account ?? ordered[0]?.account ?? null
    await prisma.uploadRoutingPolicy.update({ where: { userId }, data: { roundRobinCursor: policy.roundRobinCursor + 1 } })
    return selected
  }

  return eligible
    .sort((a, b) => {
      if (a.availableBytes === null && b.availableBytes === null) return a.account.provider === 's3' ? -1 : 1
      if (a.availableBytes === null) return a.account.provider === 's3' ? -1 : 1
      if (b.availableBytes === null) return b.account.provider === 's3' ? 1 : -1
      return Number(b.availableBytes - a.availableBytes)
    })[0]?.account
}

export async function handleUpload(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    logUpload('request started', { userId: req.user!.id, contentLength: req.headers['content-length'] })
    const contentType = req.headers['content-type']
    if (!contentType?.includes('multipart/form-data')) return res.status(400).json({ code: 'UPLOAD_INVALID_CONTENT_TYPE', message: 'multipart/form-data required.' })

    const busboy = Busboy({ headers: req.headers, limits: { files: 25, fileSize: env.MAX_UPLOAD_BYTES } })
    const fields: { sizeBytes?: bigint; fileName?: string; mimeType?: string; folderId?: string } = {}
    let batchMeta: UploadMeta[] | null = null
    let responded = false
    let fileSeen = false
    const reservedBytesByAccount = await pendingUploadBytes(req.user!.id)
    const completed: Array<Record<string, unknown>> = []
    const failed: Array<{ fileName: string; code: string; message: string }> = []
    const pendingUploads: Array<Promise<void>> = []

    const fail = async (status: number, code: string, message: string) => {
      if (responded) return
      responded = true
      req.unpipe(busboy)
      req.resume()
      return res.status(status).json({ code, message })
    }

    const parseBatchMeta = (value: string) => JSON.parse(value).map((item: { fieldName: string; fileName: string; mimeType: string; sizeBytes: string | number; folderId?: string }) => ({
      fieldName: item.fieldName,
      fileName: item.fileName,
      mimeType: item.mimeType,
      sizeBytes: BigInt(item.sizeBytes),
      folderId: item.folderId,
    })) as UploadMeta[]

    const metaForFile = (fieldName: string, info: { filename: string; mimeType: string }) => {
      if (batchMeta) return batchMeta.find((item) => item.fieldName === fieldName)
      const sizeBytes = fields.sizeBytes
      if (!sizeBytes) return null
      return { fieldName, sizeBytes, fileName: fields.fileName || info.filename, mimeType: fields.mimeType || info.mimeType || 'application/octet-stream', folderId: fields.folderId }
    }

    const uploadOne = async (fieldName: string, fileStream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      const meta = metaForFile(fieldName, info)
      const fileName = meta?.fileName || info.filename
      try {
        fileStream.on('limit', () => logUpload('file stream size limit reached', { fileName }))
        if (!meta?.sizeBytes || meta.sizeBytes <= 0n) {
          fileStream.resume()
          failed.push({ fileName, code: 'UPLOAD_SIZE_REQUIRED', message: 'sizeBytes field must be sent before file field.' })
          return
        }
        if (meta.sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) {
          fileStream.resume()
          failed.push({ fileName, code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })
          return
        }

        const folderId = meta.folderId || null
        const folderRecord = folderId ? await prisma.folder.findFirstOrThrow({ where: { id: folderId, userId: req.user!.id, deletedAt: null } }) : null

        const account = await selectAccount(req.user!.id, meta.sizeBytes, reservedBytesByAccount)
        if (!account) {
          fileStream.resume()
          failed.push({ fileName, code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE', message: 'No connected storage account has enough space for this upload.' })
          return
        }
        reservedBytesByAccount.set(account.id, (reservedBytesByAccount.get(account.id) ?? 0n) + meta.sizeBytes)

        const session = await prisma.uploadSession.create({ data: { userId: req.user!.id, targetConnectedAccountId: account.id, folderId, fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, status: 'uploading' } })
        logUpload('file upload started', { sessionId: session.id, accountId: account.id, fileName, sizeBytes: meta.sizeBytes.toString() })
        const chunks: Buffer[] = []
        fileStream.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        await new Promise<void>((resolve, reject) => {
          fileStream.on('end', resolve)
          fileStream.on('error', reject)
        })
        const fileBuffer = Buffer.concat(chunks)
        const streamedBytes = BigInt(fileBuffer.length)

        let providerFileId = ''
        let s3FileId: string | null = null
        let uploadedName = fileName
        let uploadedMimeType = meta.mimeType
        if (account.provider === 's3') {
          const config = await getS3ConfigForAccount(account.id, req.user!.id)
          const provisionalFile = await prisma.file.create({
            data: { userId: req.user!.id, connectedAccountId: account.id, folderId, provider: 's3', providerFileId: 'pending', name: fileName, mimeType: meta.mimeType, sizeBytes: meta.sizeBytes, status: 'uploading' },
          })
          s3FileId = provisionalFile.id
          providerFileId = buildS3ObjectKey(config, req.user!.id, provisionalFile.id, fileName)
          await uploadS3Object(config, providerFileId, Readable.from(fileBuffer), meta.mimeType)
          await prisma.file.update({ where: { id: provisionalFile.id }, data: { providerFileId, status: 'active' } })
          completed.push({ ...provisionalFile, providerFileId, status: 'active', sizeBytes: provisionalFile.sizeBytes.toString() })
          logUpload('s3 upload completed', { sessionId: session.id, accountId: account.id, fileName })
        } else {
          const auth = await getAuthedGoogleClient(account)
          const drive = google.drive({ version: 'v3', auth })
          const appFolderId = await ensureGoogleAppFolder(account)
          // The folder's Drive folder only exists in its own account; other accounts get the file in their 9drive folder.
          const targetParentId = folderRecord?.providerFolderId && folderRecord.connectedAccountId === account.id ? folderRecord.providerFolderId : appFolderId
          const uploaded = await drive.files.create({
            requestBody: { name: fileName, parents: [targetParentId] },
            media: { mimeType: meta.mimeType, body: Readable.from(fileBuffer) },
            fields: 'id,name,mimeType,size',
          })
          providerFileId = uploaded.data.id ?? ''
          uploadedName = uploaded.data.name ?? fileName
          uploadedMimeType = uploaded.data.mimeType ?? meta.mimeType
          logUpload('google upload completed', { sessionId: session.id, accountId: account.id, fileName })
          // Files stay private to the owning Google account; no public permissions are added.
        }

        if (streamedBytes !== meta.sizeBytes) {
          if (s3FileId) {
            await prisma.file.update({ where: { id: s3FileId }, data: { status: 'deleted', deletedAt: new Date() } }).catch(() => undefined)
            const config = await getS3ConfigForAccount(account.id, req.user!.id)
            await deleteS3ObjectByKey(config, providerFileId).catch(() => undefined)
          }
          await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'Streamed byte count did not match declared size.' } })
          failed.push({ fileName, code: 'UPLOAD_SIZE_MISMATCH', message: 'Streamed byte count did not match declared size.' })
          return
        }

        const file = account.provider === 's3' ? null : await prisma.file.create({ data: { userId: req.user!.id, connectedAccountId: account.id, folderId, provider: 'google_drive', providerFileId, name: uploadedName, mimeType: uploadedMimeType, sizeBytes: meta.sizeBytes } })
        if (file) {
          logUpload('database file created', { sessionId: session.id, fileId: file.id, accountId: account.id })
          completed.push({ ...file, sizeBytes: file.sizeBytes.toString() })
        }
        await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
        // Await for S3/R2 so the next upload sees fresh usage (keeps R2 under its free-tier cap).
        if (account.provider === 's3') await syncS3Quota(account.id).catch(() => undefined)
        else syncQuotaInBackground(account.id, session.id)
      } catch (error) {
        fileStream.resume()
        logUpload('file upload failed', { fileName, message: error instanceof Error ? error.message : 'Upload failed' })
        failed.push({ fileName, code: 'UPLOAD_FAILED', message: error instanceof Error ? error.message : 'Upload failed' })
      }
    }

    busboy.on('field', (name, value) => {
      if (name === 'sizeBytes') fields.sizeBytes = BigInt(value)
      if (name === 'fileName') fields.fileName = value
      if (name === 'mimeType') fields.mimeType = value
      if (name === 'folderId') fields.folderId = value
      if (name === 'filesMeta') batchMeta = parseBatchMeta(value)
    })

    busboy.on('file', (name, fileStream, info) => {
      fileSeen = true
      pendingUploads.push(uploadOne(name, fileStream, info))
    })

    busboy.on('error', (error) => {
      logUpload('multipart parser failed', { message: error instanceof Error ? error.message : 'Unknown error' })
      if (!responded) {
        responded = true
        next(error)
      }
    })

    busboy.on('finish', () => {
      if (!responded && !fileSeen) return fail(400, 'UPLOAD_FILE_REQUIRED', 'file field required.')
      Promise.all(pendingUploads).then(() => {
        if (responded) return
        responded = true
        logUpload('response sent', { completed: completed.length, failed: failed.length })
        if (completed.length === 0) return res.status(400).json({ code: failed[0]?.code ?? 'UPLOAD_FAILED', message: failed[0]?.message ?? 'Upload failed', failed })
        if (!batchMeta && completed.length === 1 && failed.length === 0) return res.status(201).json({ file: completed[0] })
        return res.status(201).json({ files: completed, failed })
      }).catch(next)
    })

    req.pipe(busboy)
  } catch (error) {
    return next(error)
  }
}

uploadRouter.post('/', requireAuth, handleUpload)

// Resumable upload endpoints

// 1. Initialize resumable session
uploadRouter.post('/resumable/init', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({
      fileName: z.string().min(1),
      mimeType: z.string().min(1),
      sizeBytes: z.string(),
      folderId: z.string().nullable().optional(),
      targetAccountId: z.string().nullable().optional()
    }).parse(req.body)

    const sizeBytes = BigInt(body.sizeBytes)
    if (sizeBytes <= 0n) return res.status(400).json({ code: 'UPLOAD_SIZE_REQUIRED', message: 'Valid sizeBytes required.' })
    if (sizeBytes > BigInt(env.MAX_UPLOAD_BYTES)) return res.status(400).json({ code: 'UPLOAD_TOO_LARGE', message: 'File exceeds max upload size.' })

    const folderId = body.folderId || null
    const folderRecord = folderId ? await prisma.folder.findFirstOrThrow({ where: { id: folderId, userId: req.user!.id, deletedAt: null } }) : null

    const account = await selectAccount(req.user!.id, sizeBytes, await pendingUploadBytes(req.user!.id), body.targetAccountId)
    if (!account) return res.status(400).json({ code: 'NO_ACCOUNT_WITH_ENOUGH_SPACE', message: 'No connected storage account has enough space.' })

    if (account.provider === 's3') {
      // S3/R2: browser chunks become parts of an S3 multipart upload.
      const config = await getS3ConfigForAccount(account.id, req.user!.id)
      const session = await prisma.uploadSession.create({
        data: {
          userId: req.user!.id,
          targetConnectedAccountId: account.id,
          folderId,
          fileName: body.fileName,
          mimeType: body.mimeType,
          sizeBytes,
          status: 'uploading'
        }
      })
      const uploadId = await createS3MultipartUpload(config, buildS3ObjectKey(config, req.user!.id, session.id, body.fileName), body.mimeType)
      await prisma.uploadSession.update({ where: { id: session.id }, data: { s3UploadId: uploadId } })
      return res.status(201).json({ sessionId: session.id, provider: 's3', offset: 0 })
    }

    if (account.provider !== 'google_drive') {
      return res.status(400).json({ code: 'UNSUPPORTED_PROVIDER', message: 'Unsupported storage provider.' })
    }

    const auth = await getAuthedGoogleClient(account)
    const appFolderId = await ensureGoogleAppFolder(account)
    // The folder's Drive folder only exists in its own account; other accounts get the file in their 9drive folder.
    const targetParentId = folderRecord?.providerFolderId && folderRecord.connectedAccountId === account.id ? folderRecord.providerFolderId : appFolderId

    // Initiate Google Drive Resumable Session
    const headers = new Headers()
    const token = await auth.getAccessToken()
    headers.set('Authorization', `Bearer ${token.token}`)
    headers.set('Content-Type', 'application/json')
    headers.set('X-Upload-Content-Type', body.mimeType)
    headers.set('X-Upload-Content-Length', sizeBytes.toString())

    const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: body.fileName,
        parents: [targetParentId]
      })
    })

    if (!initRes.ok) {
      const errText = await initRes.text()
      throw new Error(`Google API Init Error: ${errText}`)
    }

    const sessionUri = initRes.headers.get('location')
    if (!sessionUri) throw new Error('Google API did not return Location header.')

    const session = await prisma.uploadSession.create({
      data: {
        userId: req.user!.id,
        targetConnectedAccountId: account.id,
        folderId,
        fileName: body.fileName,
        mimeType: body.mimeType,
        sizeBytes,
        status: 'uploading',
        googleSessionUri: sessionUri
      }
    })

    return res.status(201).json({ sessionId: session.id, provider: 'google_drive', offset: 0 })
  } catch (error) {
    return next(error)
  }
})

// 2. Query/Resume resumable status
uploadRouter.get('/resumable/status/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const session = await prisma.uploadSession.findFirstOrThrow({
      where: { id: String(req.params.id), userId: req.user!.id }
    })

    if (session.status === 'completed') {
      return res.json({ status: 'completed', offset: session.sizeBytes.toString() })
    }

    if (session.s3UploadId && session.targetConnectedAccountId) {
      // Resume after the last part that S3 has, counting only an unbroken run from part 1.
      const config = await getS3ConfigForAccount(session.targetConnectedAccountId, req.user!.id)
      const parts = await listS3UploadedParts(config, buildS3ObjectKey(config, req.user!.id, session.id, session.fileName), session.s3UploadId)
      let contiguous = 0
      while (parts[contiguous]?.partNumber === contiguous + 1 && parts[contiguous].size === S3_PART_SIZE) contiguous += 1
      // Never skip the final part: sending it is what completes the upload.
      const finalPartStart = ((session.sizeBytes - 1n) / BigInt(S3_PART_SIZE)) * BigInt(S3_PART_SIZE)
      const offset = BigInt(contiguous) * BigInt(S3_PART_SIZE)
      return res.json({ status: 'uploading', offset: (offset < finalPartStart ? offset : finalPartStart).toString() })
    }

    if (!session.googleSessionUri || !session.targetConnectedAccountId) {
      return res.json({ status: 'uploading', offset: '0' })
    }

    const account = await prisma.connectedAccount.findFirstOrThrow({
      where: { id: session.targetConnectedAccountId, userId: req.user!.id }
    })
    const auth = await getAuthedGoogleClient(account)
    const token = await auth.getAccessToken()

    // Query Google Drive for uploaded offset
    const queryHeaders = new Headers()
    queryHeaders.set('Authorization', `Bearer ${token.token}`)
    queryHeaders.set('Content-Range', `bytes */${session.sizeBytes}`)

    const queryRes = await fetch(session.googleSessionUri, {
      method: 'PUT',
      headers: queryHeaders
    })

    if (queryRes.status === 308) {
      const range = queryRes.headers.get('range')
      if (range) {
        // e.g. bytes=0-1048575
        const parts = range.split('-')
        const lastByte = BigInt(parts[1])
        return res.json({ status: 'uploading', offset: (lastByte + 1n).toString() })
      }
    } else if (queryRes.ok) {
      return res.json({ status: 'completed', offset: session.sizeBytes.toString() })
    } else if (queryRes.status === 404 || queryRes.status === 410) {
      // Google discarded the upload session (expired); the client starts a new upload.
      return res.json({ status: 'failed', offset: '0' })
    }

    return res.json({ status: 'uploading', offset: '0' })
  } catch (error) {
    return res.json({ status: 'failed', offset: '0' })
  }
})

// 3. Upload chunk
uploadRouter.put('/resumable/chunk/:id', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const session = await prisma.uploadSession.findFirstOrThrow({
      where: { id: String(req.params.id), userId: req.user!.id }
    })

    const rangeHeader = req.headers['content-range']
    if (!rangeHeader || typeof rangeHeader !== 'string') {
      return res.status(400).json({ code: 'MISSING_CONTENT_RANGE', message: 'Content-Range header is required.' })
    }

    // Parse Content-Range, e.g. bytes 0-5242879/10485760
    const match = rangeHeader.match(/bytes\s+(\d+)-(\d+)\/(\d+)/)
    if (!match) return res.status(400).json({ code: 'INVALID_CONTENT_RANGE', message: 'Invalid Content-Range format.' })

    const startByte = BigInt(match[1])
    const endByte = BigInt(match[2])
    const totalBytes = BigInt(match[3])

    if (session.s3UploadId && session.targetConnectedAccountId) {
      const partSize = BigInt(S3_PART_SIZE)
      const chunkBytes = endByte - startByte + 1n
      const isLast = endByte + 1n === totalBytes
      if (totalBytes !== session.sizeBytes || endByte < startByte || endByte >= totalBytes || startByte % partSize !== 0n || (!isLast && chunkBytes !== partSize) || chunkBytes > partSize) {
        return res.status(400).json({ code: 'INVALID_CONTENT_RANGE', message: 'Chunks must be 5 MiB parts in order.' })
      }
      const body = await readChunk(req, Number(chunkBytes))
      if (BigInt(body.length) !== chunkBytes) return res.status(400).json({ code: 'UPLOAD_SIZE_MISMATCH', message: 'Chunk size did not match Content-Range.' })

      const config = await getS3ConfigForAccount(session.targetConnectedAccountId, req.user!.id)
      const key = buildS3ObjectKey(config, req.user!.id, session.id, session.fileName)
      await uploadS3Part(config, key, session.s3UploadId, Number(startByte / partSize) + 1, body)
      if (!isLast) return res.json({ status: 'uploading', offset: (endByte + 1n).toString() })

      const uploadedBytes = await completeS3MultipartUpload(config, key, session.s3UploadId)
      if (uploadedBytes !== totalBytes) {
        // Remove the bad object so it does not use storage without a file record.
        await deleteS3ObjectByKey(config, key).catch(() => undefined)
        await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'failed', errorMessage: 'Uploaded size did not match declared size.' } })
        return res.status(400).json({ code: 'UPLOAD_SIZE_MISMATCH', message: 'Uploaded size did not match declared size.' })
      }
      const file = await prisma.file.create({
        data: { userId: req.user!.id, connectedAccountId: session.targetConnectedAccountId, folderId: session.folderId, provider: 's3', providerFileId: key, name: session.fileName, mimeType: session.mimeType, sizeBytes: totalBytes }
      })
      await prisma.uploadSession.update({ where: { id: session.id }, data: { status: 'completed', completedAt: new Date() } })
      await createAuditLog(req.user!.id, 'UPLOAD_FILE', 'file', file.id, { name: file.name, size: file.sizeBytes.toString() })
      // Await so the next upload sees fresh usage (keeps R2 under its free-tier cap).
      await syncS3Quota(session.targetConnectedAccountId).catch(() => undefined)
      return res.status(201).json({ status: 'completed', file: { ...file, sizeBytes: file.sizeBytes.toString() } })
    }

    if (!session.googleSessionUri || !session.targetConnectedAccountId) {
      return res.status(400).json({ code: 'UNSUPPORTED_PROVIDER', message: 'Only Google Drive resumable uploads supported.' })
    }

    const account = await prisma.connectedAccount.findFirstOrThrow({
      where: { id: session.targetConnectedAccountId, userId: req.user!.id }
    })
    const auth = await getAuthedGoogleClient(account)
    const token = await auth.getAccessToken()

    // Stream chunk body from client to Google Drive resumable URI
    const putHeaders = new Headers()
    putHeaders.set('Authorization', `Bearer ${token.token}`)
    putHeaders.set('Content-Range', rangeHeader)
    putHeaders.set('Content-Length', (endByte - startByte + 1n).toString())

    const putRes = await fetch(session.googleSessionUri, {
      method: 'PUT',
      headers: putHeaders,
      body: req as any,
      duplex: 'half'
    } as any)

    if (putRes.status === 308) {
      return res.json({ status: 'uploading', offset: (endByte + 1n).toString() })
    }

    if (putRes.ok) {
      // Completed! Parse metadata
      const fileMeta = await putRes.json() as { id: string; name: string; mimeType: string }

      let existingFile = await prisma.file.findFirst({
        where: { providerFileId: fileMeta.id, userId: req.user!.id }
      })

      if (!existingFile) {
        existingFile = await prisma.file.create({
          data: {
            userId: req.user!.id,
            connectedAccountId: account.id,
            folderId: session.folderId,
            provider: 'google_drive',
            providerFileId: fileMeta.id,
            name: fileMeta.name || session.fileName,
            mimeType: fileMeta.mimeType || session.mimeType,
            sizeBytes: totalBytes
          }
        })
      }

      await prisma.uploadSession.update({
        where: { id: session.id },
        data: { status: 'completed', completedAt: new Date() }
      })

      await createAuditLog(req.user!.id, 'UPLOAD_FILE', 'file', existingFile.id, { name: existingFile.name, size: existingFile.sizeBytes.toString() })

      syncQuotaInBackground(account.id, session.id)

      return res.status(201).json({ status: 'completed', file: { ...existingFile, sizeBytes: existingFile.sizeBytes.toString() } })
    }

    const errorMsg = await putRes.text()
    await prisma.uploadSession.update({
      where: { id: session.id },
      data: { status: 'failed', errorMessage: errorMsg }
    })

    return res.status(putRes.status).json({ code: 'UPLOAD_FAILED', message: errorMsg })
  } catch (error) {
    return next(error)
  }
})
