import { Router, type Response } from 'express'
import { google } from 'googleapis'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { getAuthedGoogleClient, ensureGoogleAppFolder } from '../google/google.service.js'
import { createAuditLog } from '../../utils/audit.js'
import { hashPassword, verifyPassword } from '../../utils/password.js'
import { hasReachedLimit, isRateLimited } from '../../utils/rate-limit.js'
import { collectFolderFiles, createDownloadToken, safeSegment } from '../files/downloads.js'
import { getLockState, hasLockInside, isFolderBlocked, openFilesFilter, sendFolderLocked, signFolderUnlock, type LockState } from './folder-lock.js'

export const folderRouter = Router()
folderRouter.use(requireAuth)

const defaultFolderColor = '#3b82f6'
const defaultFolderIconUrl = 'https://api.iconify.design/lucide:folder.svg'
const iconUrlSchema = z.string().url().startsWith('https://api.iconify.design/lucide:').max(2048)
const colorSchema = z.string().regex(/^(#[0-9a-fA-F]{6}|text-[a-z]+-[0-9]+)$/).max(64)

const createSchema = z.object({
  name: z.string().min(1).max(255),
  color: colorSchema.optional(),
  iconUrl: iconUrlSchema.nullable().optional(),
  parentId: z.string().nullable().optional(),
})

const folderSelect = { id: true, name: true, color: true, iconUrl: true, parentId: true, providerFolderId: true, createdAt: true, updatedAt: true, lockHash: true } as const

type SelectedFolder = { id: string; name: string; color: string; iconUrl?: string | null; parentId?: string | null; providerFolderId?: string | null; createdAt: Date; updatedAt: Date; lockHash?: string | null }

// The lock itself (its hash) never leaves the server; the app only learns whether a folder is locked/unlocked.
function serializeFolder(folder: SelectedFolder, state?: LockState) {
  const { lockHash, ...rest } = folder
  return { ...rest, providerFolderId: folder.providerFolderId ?? null, createdAt: folder.createdAt.toISOString(), updatedAt: folder.updatedAt.toISOString(), locked: Boolean(lockHash), unlocked: Boolean(state?.unlocked.has(folder.id)) }
}

// Folder lock passwords: at least 4 characters (a 4-digit PIN works).
const lockPasswordSchema = z.string().min(4, 'Use at least 4 characters.').max(128)
const MAX_FAILED_UNLOCKS = 10
const MAX_FAILED_ACCOUNT_PASSWORDS = 5
const FAILED_ATTEMPT_WINDOW_MS = 15 * 60_000

function tooManyAttempts(res: Response) {
  return res.status(429).json({ code: 'TOO_MANY_ATTEMPTS', message: 'Too many wrong passwords. Try again in 15 minutes.' })
}

async function ensureProviderFolderIds(
  folders: Array<{ id: string; name: string; parentId: string | null; providerFolderId: string | null }>,
  userId: string
) {
  const foldersWithoutId = folders.filter((f) => !f.providerFolderId)
  if (foldersWithoutId.length === 0) return

  const connectedAccount = await prisma.connectedAccount.findFirst({
    where: { userId, provider: 'google_drive', status: 'connected' }
  })
  if (!connectedAccount) return

  try {
    const auth = await getAuthedGoogleClient(connectedAccount)
    const drive = google.drive({ version: 'v3', auth })
    const appFolderId = await ensureGoogleAppFolder(connectedAccount)

    for (const folder of foldersWithoutId) {
      try {
        let parentGoogleId = appFolderId
        if (folder.parentId) {
          const parentFolder = await prisma.folder.findFirst({
            where: { id: folder.parentId, userId }
          })
          if (parentFolder?.providerFolderId) {
            parentGoogleId = parentFolder.providerFolderId
          }
        }

        const driveFolder = await drive.files.create({
          requestBody: {
            name: folder.name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentGoogleId]
          },
          fields: 'id'
        })

        const gId = driveFolder.data.id ?? null
        if (gId) {
          await prisma.folder.update({
            where: { id: folder.id },
            data: { providerFolderId: gId, connectedAccountId: connectedAccount.id }
          })
          folder.providerFolderId = gId
        }
      } catch (error) {
        console.error(`Failed self-healing for folder ${folder.id}:`, error instanceof Error ? error.message : error)
      }
    }
  } catch (error) {
    console.error('Failed self-healing Google Drive auth:', error instanceof Error ? error.message : error)
  }
}

// Folders inside a locked folder are hidden (a locked folder itself is shown, marked as locked).
folderRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const query = z.object({ parentId: z.string().nullable().optional(), all: z.string().optional() }).parse(req.query)
    const state = await getLockState(req)
    if (query.all !== '1' && query.parentId && isFolderBlocked(state, query.parentId)) return sendFolderLocked(res, state, query.parentId)
    const folders = (await prisma.folder.findMany({
      where: { userId: req.user!.id, deletedAt: null, ...(query.all === '1' ? {} : { parentId: query.parentId ?? null }) },
      select: folderSelect,
      orderBy: { updatedAt: 'desc' },
    })).filter((folder) => !isFolderBlocked(state, folder.parentId))
    await ensureProviderFolderIds(folders, req.user!.id)
    return res.json({ folders: folders.map((folder) => serializeFolder(folder, state)) })
  } catch (error) {
    return next(error)
  }
})

// Up to 4 newest photos/videos directly inside each folder, shown as the folder's cover (never for locked folders).
folderRouter.get('/covers', async (req: AuthRequest, res, next) => {
  try {
    const state = await getLockState(req)
    const files = await prisma.file.findMany({
      where: {
        userId: req.user!.id,
        status: 'active',
        folderId: { not: null },
        AND: [openFilesFilter(state)],
        OR: [
          { mimeType: { startsWith: 'image/' } },
          // S3/R2 has no video thumbnails, so only Google Drive videos can be covers.
          { mimeType: { startsWith: 'video/' }, provider: 'google_drive' },
        ],
      },
      select: { id: true, folderId: true },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    })
    const covers: Record<string, string[]> = {}
    for (const file of files) {
      const list = (covers[file.folderId!] ??= [])
      if (list.length < 4) list.push(file.id)
    }
    return res.json({ covers })
  } catch (error) {
    return next(error)
  }
})

folderRouter.get('/recent', async (req: AuthRequest, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 4), 4)
    const state = await getLockState(req)
    const folders = (await prisma.folder.findMany({
      where: { userId: req.user!.id, deletedAt: null },
      select: folderSelect,
      orderBy: { updatedAt: 'desc' },
    })).filter((folder) => !isFolderBlocked(state, folder.parentId)).slice(0, limit)
    await ensureProviderFolderIds(folders, req.user!.id)
    return res.json({ folders: folders.map((folder) => serializeFolder(folder, state)) })
  } catch (error) {
    return next(error)
  }
})

folderRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const body = createSchema.parse(req.body)
    let parentFolder = null
    if (body.parentId) {
      parentFolder = await prisma.folder.findFirstOrThrow({
        where: { id: body.parentId, userId: req.user!.id, deletedAt: null }
      })
      const state = await getLockState(req)
      if (isFolderBlocked(state, body.parentId)) return sendFolderLocked(res, state, body.parentId)
    }

    const connectedAccount = await prisma.connectedAccount.findFirst({
      where: { userId: req.user!.id, provider: 'google_drive', status: 'connected' }
    })

    let providerFolderId: string | null = null
    if (connectedAccount) {
      try {
        const auth = await getAuthedGoogleClient(connectedAccount)
        const drive = google.drive({ version: 'v3', auth })

        let googleParentId = await ensureGoogleAppFolder(connectedAccount)
        if (parentFolder && parentFolder.providerFolderId) {
          googleParentId = parentFolder.providerFolderId
        }

        const driveFolder = await drive.files.create({
          requestBody: {
            name: body.name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [googleParentId]
          },
          fields: 'id'
        })
        providerFolderId = driveFolder.data.id ?? null
      } catch (error) {
        console.error('Failed to create folder on Google Drive:', error instanceof Error ? error.message : error)
      }
    }

    const folder = await prisma.folder.create({
      data: {
        userId: req.user!.id,
        name: body.name,
        color: body.color ?? defaultFolderColor,
        iconUrl: body.iconUrl ?? defaultFolderIconUrl,
        parentId: body.parentId ?? null,
        providerFolderId,
        connectedAccountId: connectedAccount?.id ?? null
      },
      select: folderSelect,
    })
    await createAuditLog(req.user!.id, 'CREATE_FOLDER', 'folder', folder.id, { name: folder.name, parentId: folder.parentId })
    return res.status(201).json({ folder: serializeFolder(folder) })
  } catch (error) {
    return next(error)
  }
})

folderRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const body = createSchema.partial().parse(req.body)
    const folderId = String(req.params.id)
    if (body.parentId === folderId) return res.status(400).json({ code: 'FOLDER_INVALID_PARENT', message: 'Folder cannot be moved into itself.' })

    const folderRecord = await prisma.folder.findFirstOrThrow({
      where: { id: folderId, userId: req.user!.id, deletedAt: null },
      include: { connectedAccount: true }
    })
    // A locked folder can only be renamed or moved while it is unlocked; nothing can be moved into a closed one.
    const state = await getLockState(req)
    if (isFolderBlocked(state, folderId)) return sendFolderLocked(res, state, folderId)
    if (body.parentId && isFolderBlocked(state, body.parentId)) return sendFolderLocked(res, state, body.parentId)

    if (body.parentId) {
      await prisma.folder.findFirstOrThrow({ where: { id: body.parentId, userId: req.user!.id, deletedAt: null } })
      const folders = await prisma.folder.findMany({ where: { userId: req.user!.id, deletedAt: null }, select: { id: true, parentId: true } })
      const descendantIds = new Set<string>([folderId])
      let changed = true
      while (changed) {
        changed = false
        for (const folder of folders) {
          if (folder.parentId && descendantIds.has(folder.parentId) && !descendantIds.has(folder.id)) {
            descendantIds.add(folder.id)
            changed = true
          }
        }
      }
      if (descendantIds.has(body.parentId)) return res.status(400).json({ code: 'FOLDER_INVALID_PARENT', message: 'Folder cannot be moved into itself or a child folder.' })
    }

    // Update name on Google Drive if changed
    if (body.name && folderRecord.providerFolderId && folderRecord.connectedAccount) {
      try {
        const auth = await getAuthedGoogleClient(folderRecord.connectedAccount)
        const drive = google.drive({ version: 'v3', auth })
        await drive.files.update({
          fileId: folderRecord.providerFolderId,
          requestBody: { name: body.name }
        })
      } catch (error) {
        console.error('Failed to rename folder on Google Drive:', error instanceof Error ? error.message : error)
      }
    }

    // Update parent on Google Drive if moved
    if (body.parentId !== undefined && folderRecord.providerFolderId && folderRecord.connectedAccount) {
      try {
        const auth = await getAuthedGoogleClient(folderRecord.connectedAccount)
        const drive = google.drive({ version: 'v3', auth })

        let newGoogleParentId = await ensureGoogleAppFolder(folderRecord.connectedAccount)
        if (body.parentId) {
          const newParent = await prisma.folder.findFirst({ where: { id: body.parentId, userId: req.user!.id } })
          if (newParent?.providerFolderId) {
            newGoogleParentId = newParent.providerFolderId
          }
        }

        const fileInfo = await drive.files.get({ fileId: folderRecord.providerFolderId, fields: 'parents' })
        const previousParents = fileInfo.data.parents?.join(',')

        await drive.files.update({
          fileId: folderRecord.providerFolderId,
          addParents: newGoogleParentId,
          removeParents: previousParents,
          fields: 'id, parents'
        })
      } catch (error) {
        console.error('Failed to move folder on Google Drive:', error instanceof Error ? error.message : error)
      }
    }

    const folder = await prisma.folder.updateMany({
      where: { id: folderId, userId: req.user!.id, deletedAt: null },
      data: { ...(body.name ? { name: body.name } : {}), ...(body.color ? { color: body.color } : {}), ...(body.iconUrl !== undefined ? { iconUrl: body.iconUrl } : {}), ...(body.parentId !== undefined ? { parentId: body.parentId } : {}) },
    })
    if (folder.count === 0) return res.status(404).json({ code: 'FOLDER_NOT_FOUND', message: 'Folder not found.' })
    const updated = await prisma.folder.findFirstOrThrow({
      where: { id: folderId, userId: req.user!.id },
      select: folderSelect,
    })
    await createAuditLog(req.user!.id, 'UPDATE_FOLDER', 'folder', updated.id, { name: updated.name, parentId: updated.parentId, updates: body })
    return res.json({ folder: serializeFolder(updated, state) })
  } catch (error) {
    return next(error)
  }
})

folderRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const rootId = String(req.params.id)
    const root = await prisma.folder.findFirstOrThrow({ where: { id: rootId, userId: req.user!.id, deletedAt: null } })
    const state = await getLockState(req)
    if (isFolderBlocked(state, rootId)) return sendFolderLocked(res, state, rootId)
    // Deleting would move locked files to the Recycle Bin and out of their lock; the lock has to be removed first.
    if (hasLockInside(state, rootId)) return res.status(409).json({ code: 'FOLDER_HAS_LOCK', message: 'This folder (or a folder inside it) is locked. Remove the lock first, then delete it.' })
    const folders = await prisma.folder.findMany({ where: { userId: req.user!.id, deletedAt: null }, select: { id: true, parentId: true } })
    const folderIds = new Set<string>([root.id])
    let changed = true
    while (changed) {
      changed = false
      for (const folder of folders) {
        if (folder.parentId && folderIds.has(folder.parentId) && !folderIds.has(folder.id)) {
          folderIds.add(folder.id)
          changed = true
        }
      }
    }

    // Files go to the app's Recycle Bin (restorable, removed from storage only when emptied there), same as deleting
    // a single file. Google files are first moved out of the folder's Drive folder, because trashing that Drive
    // folder would also trash everything inside it. S3/R2 files need no storage change here.
    const files = await prisma.file.findMany({ where: { userId: req.user!.id, status: 'active', folderId: { in: [...folderIds] } }, include: { connectedAccount: true } })
    const appFolderIds = new Map<string, string>()
    const accountsWithFailedMoves = new Set<string>()
    for (const file of files) {
      if (file.provider !== 'google_drive') continue
      try {
        const auth = await getAuthedGoogleClient(file.connectedAccount)
        const drive = google.drive({ version: 'v3', auth })
        let appFolderId = appFolderIds.get(file.connectedAccountId)
        if (!appFolderId) {
          appFolderId = await ensureGoogleAppFolder(file.connectedAccount)
          appFolderIds.set(file.connectedAccountId, appFolderId)
        }
        const info = await drive.files.get({ fileId: file.providerFileId, fields: 'parents' })
        const otherParents = (info.data.parents ?? []).filter((parent) => parent !== appFolderId)
        if (otherParents.length > 0) await drive.files.update({ fileId: file.providerFileId, addParents: appFolderId, removeParents: otherParents.join(','), fields: 'id' })
      } catch (error) {
        accountsWithFailedMoves.add(file.connectedAccountId)
        console.error(`Failed to move file ${file.id} out of deleted folder:`, error instanceof Error ? error.message : error)
      }
    }

    // Trash the (now empty) Drive folders; skipped for an account where a file could not be moved out.
    const foldersToDelete = await prisma.folder.findMany({ where: { id: { in: [...folderIds] }, userId: req.user!.id }, include: { connectedAccount: true } })
    for (const f of foldersToDelete) {
      if (f.providerFolderId && f.connectedAccount && f.connectedAccountId && !accountsWithFailedMoves.has(f.connectedAccountId)) {
        try {
          const auth = await getAuthedGoogleClient(f.connectedAccount)
          const drive = google.drive({ version: 'v3', auth })
          await drive.files.update({ fileId: f.providerFolderId, requestBody: { trashed: true } })
        } catch {
          // ignore
        }
      }
    }

    await prisma.file.updateMany({ where: { id: { in: files.map((file) => file.id) } }, data: { status: 'deleted', deletedAt: new Date() } })
    await prisma.folder.updateMany({ where: { id: { in: [...folderIds] }, userId: req.user!.id }, data: { deletedAt: new Date() } })

    await createAuditLog(req.user!.id, 'DELETE_FOLDER', 'folder', root.id, { name: root.name, parentId: root.parentId })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

// Put a lock (its own password) on a folder. The answer includes an unlock, so a folder locked from inside stays
// open until the user leaves it.
folderRouter.post('/:id/lock', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ password: lockPasswordSchema }).parse(req.body)
    const folderId = String(req.params.id)
    const folder = await prisma.folder.findFirstOrThrow({ where: { id: folderId, userId: req.user!.id, deletedAt: null } })
    if (folder.lockHash) return res.status(409).json({ code: 'FOLDER_ALREADY_LOCKED', message: 'This folder is already locked. Use Change lock password instead.' })
    const state = await getLockState(req)
    if (isFolderBlocked(state, folderId)) return sendFolderLocked(res, state, folderId)
    const locked = await prisma.folder.update({ where: { id: folder.id }, data: { lockHash: await hashPassword(body.password), lockedAt: new Date() } })
    await createAuditLog(req.user!.id, 'LOCK_FOLDER', 'folder', folder.id, { name: folder.name, parentId: folder.parentId })
    return res.json({ status: 'ok', unlockToken: signFolderUnlock(req, locked) })
  } catch (error) {
    return next(error)
  }
})

folderRouter.post('/:id/unlock', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ password: z.string().min(1).max(128) }).parse(req.body)
    const limitKey = `folder-unlock:${req.user!.id}`
    if (hasReachedLimit(limitKey, MAX_FAILED_UNLOCKS)) return tooManyAttempts(res)
    const folderId = String(req.params.id)
    const folder = await prisma.folder.findFirstOrThrow({ where: { id: folderId, userId: req.user!.id, deletedAt: null } })
    const state = await getLockState(req)
    // A locked folder inside another locked folder is opened from the outside in.
    if (isFolderBlocked(state, folder.parentId)) return sendFolderLocked(res, state, folder.parentId)
    if (!folder.lockHash) return res.json({ status: 'ok', unlockToken: null })
    if (!(await verifyPassword(folder.lockHash, body.password))) {
      isRateLimited(limitKey, MAX_FAILED_UNLOCKS, FAILED_ATTEMPT_WINDOW_MS)
      await createAuditLog(req.user!.id, 'UNLOCK_FOLDER_FAILED', 'folder', folder.id, { name: folder.name, parentId: folder.parentId })
      return res.status(403).json({ code: 'FOLDER_PASSWORD_WRONG', message: 'Wrong folder password.' })
    }
    await createAuditLog(req.user!.id, 'UNLOCK_FOLDER', 'folder', folder.id, { name: folder.name, parentId: folder.parentId })
    return res.json({ status: 'ok', unlockToken: signFolderUnlock(req, folder) })
  } catch (error) {
    return next(error)
  }
})

// New lock password: needs the current one. Unlocks given out before stop working.
folderRouter.patch('/:id/lock', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: lockPasswordSchema }).parse(req.body)
    const limitKey = `folder-unlock:${req.user!.id}`
    if (hasReachedLimit(limitKey, MAX_FAILED_UNLOCKS)) return tooManyAttempts(res)
    const folderId = String(req.params.id)
    const folder = await prisma.folder.findFirstOrThrow({ where: { id: folderId, userId: req.user!.id, deletedAt: null } })
    if (!folder.lockHash) return res.status(400).json({ code: 'FOLDER_NOT_LOCKED', message: 'This folder is not locked.' })
    const state = await getLockState(req)
    if (isFolderBlocked(state, folder.parentId)) return sendFolderLocked(res, state, folder.parentId)
    if (!(await verifyPassword(folder.lockHash, body.currentPassword))) {
      isRateLimited(limitKey, MAX_FAILED_UNLOCKS, FAILED_ATTEMPT_WINDOW_MS)
      return res.status(403).json({ code: 'FOLDER_PASSWORD_WRONG', message: 'The current folder password is wrong.' })
    }
    const updated = await prisma.folder.update({ where: { id: folder.id }, data: { lockHash: await hashPassword(body.newPassword), lockedAt: new Date() } })
    await createAuditLog(req.user!.id, 'CHANGE_FOLDER_LOCK', 'folder', folder.id, { name: folder.name, parentId: folder.parentId })
    return res.json({ status: 'ok', unlockToken: signFolderUnlock(req, updated) })
  } catch (error) {
    return next(error)
  }
})

// Removing a lock (also the way out when its password is forgotten) needs the 9Drive account password.
folderRouter.post('/:id/remove-lock', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ accountPassword: z.string().min(1).max(256) }).parse(req.body)
    const limitKey = `account-password:${req.user!.id}`
    if (hasReachedLimit(limitKey, MAX_FAILED_ACCOUNT_PASSWORDS)) return tooManyAttempts(res)
    const folderId = String(req.params.id)
    const folder = await prisma.folder.findFirstOrThrow({ where: { id: folderId, userId: req.user!.id, deletedAt: null } })
    const state = await getLockState(req)
    if (isFolderBlocked(state, folder.parentId)) return sendFolderLocked(res, state, folder.parentId)
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } })
    if (!(await verifyPassword(user.passwordHash, body.accountPassword))) {
      isRateLimited(limitKey, MAX_FAILED_ACCOUNT_PASSWORDS, FAILED_ATTEMPT_WINDOW_MS)
      await createAuditLog(req.user!.id, 'REMOVE_FOLDER_LOCK_FAILED', 'folder', folder.id, { name: folder.name, parentId: folder.parentId })
      return res.status(403).json({ code: 'ACCOUNT_PASSWORD_WRONG', message: 'Wrong account password.' })
    }
    await prisma.folder.update({ where: { id: folder.id }, data: { lockHash: null, lockedAt: null } })
    await createAuditLog(req.user!.id, 'REMOVE_FOLDER_LOCK', 'folder', folder.id, { name: folder.name, parentId: folder.parentId })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

// Folder download as one ZIP (subfolders kept as folders inside it). Locked subfolders are left out.
folderRouter.post('/:id/zip-link', async (req: AuthRequest, res, next) => {
  try {
    const folderId = String(req.params.id)
    const state = await getLockState(req)
    if (isFolderBlocked(state, folderId)) return sendFolderLocked(res, state, folderId)
    const collected = await collectFolderFiles(state, req.user!.id, folderId)
    if (!collected) return res.status(404).json({ code: 'NOT_FOUND', message: 'Not found.' })
    if (collected.entries.length === 0) return res.status(404).json({ code: 'FOLDER_EMPTY', message: collected.lockedSubfolders ? 'Only locked folders are inside. Open them to download their files.' : 'This folder has no files.' })
    const token = await createDownloadToken(req.user!.id, 'zip', collected.entries.map((entry) => ({ id: entry.file.id, path: entry.path })), `${safeSegment(collected.root.name)}.zip`, folderId)
    await createAuditLog(req.user!.id, 'DOWNLOAD_FOLDER', 'folder', folderId, folderDownloadDetails(collected, 'ZIP'))
    return res.status(201).json({ path: `/files/zip/${token}`, count: collected.entries.length, lockedSubfolders: collected.lockedSubfolders })
  } catch (error) {
    return next(error)
  }
})

// File list for saving a folder as a normal folder on this computer (the app then downloads file by file).
folderRouter.get('/:id/download-list', async (req: AuthRequest, res, next) => {
  try {
    const folderId = String(req.params.id)
    const state = await getLockState(req)
    if (isFolderBlocked(state, folderId)) return sendFolderLocked(res, state, folderId)
    const collected = await collectFolderFiles(state, req.user!.id, folderId)
    if (!collected) return res.status(404).json({ code: 'NOT_FOUND', message: 'Not found.' })
    await createAuditLog(req.user!.id, 'DOWNLOAD_FOLDER', 'folder', folderId, folderDownloadDetails(collected, 'folder'))
    return res.json({
      name: safeSegment(collected.root.name),
      lockedSubfolders: collected.lockedSubfolders,
      files: collected.entries.map((entry) => ({ id: entry.file.id, name: entry.file.name, path: entry.path, sizeBytes: entry.file.sizeBytes.toString() })),
    })
  } catch (error) {
    return next(error)
  }
})

function folderDownloadDetails(collected: NonNullable<Awaited<ReturnType<typeof collectFolderFiles>>>, mode: 'ZIP' | 'folder') {
  return {
    name: collected.root.name,
    parentId: collected.root.parentId,
    mode,
    count: collected.entries.length,
    sizeBytes: collected.entries.reduce((total, entry) => total + entry.file.sizeBytes, 0n).toString(),
    lockedSubfolders: collected.lockedSubfolders,
  }
}
