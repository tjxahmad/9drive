import type { Response } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../../config/env.js'
import { prisma } from '../../config/prisma.js'
import type { AuthRequest } from '../../middleware/auth.middleware.js'

// Folder locks: a locked folder, its subfolders and every file inside them can only be opened after the folder's
// own password is entered. Entering it gives a short-lived unlock token, bound to the login session and to the
// current lock, which the app keeps in memory only and sends back in the X-Folder-Unlock header. Every request
// works out which folders are still closed (see getLockState) and refuses or hides what is inside them.

// The app itself forgets an unlock when the user leaves the folder or is idle; this is only the upper limit
// (long enough for a big upload into the folder to finish).
const UNLOCK_TTL_SECONDS = 12 * 60 * 60
const UNLOCK_HEADER = 'x-folder-unlock'

type FolderNode = { id: string; name: string; parentId: string | null; lockHash: string | null; lockedAt: Date | null; deletedAt: Date | null }
type UnlockPayload = { sub: string; sid: string; fid: string; lv: number; typ: string }

export type LockState = {
  folders: Map<string, FolderNode>
  // Locked folders that were not unlocked, plus everything inside them (deleted folders included).
  blocked: Set<string>
  unlocked: Set<string>
}

function lockVersion(folder: { lockedAt: Date | null }) {
  return folder.lockedAt?.getTime() ?? 0
}

export function signFolderUnlock(req: AuthRequest, folder: { id: string; lockedAt: Date | null }) {
  const payload = { sub: req.user!.id, sid: req.user!.sessionId, fid: folder.id, lv: lockVersion(folder), typ: 'folder-unlock' }
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: UNLOCK_TTL_SECONDS })
}

function unlockedFolderIds(req: AuthRequest, folders: Map<string, FolderNode>) {
  const header = req.headers[UNLOCK_HEADER]
  const tokens = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map((token) => token.trim()).filter(Boolean).slice(0, 50)
  const unlocked = new Set<string>()
  for (const token of tokens) {
    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as UnlockPayload
      if (payload.typ !== 'folder-unlock' || payload.sub !== req.user!.id || payload.sid !== req.user!.sessionId) continue
      const folder = folders.get(payload.fid)
      // A changed or removed lock makes older unlocks useless.
      if (folder?.lockHash && lockVersion(folder) === payload.lv) unlocked.add(folder.id)
    } catch {
      // Expired or forged token: the folder stays locked.
    }
  }
  return unlocked
}

export async function getLockState(req: AuthRequest): Promise<LockState> {
  const rows = await prisma.folder.findMany({
    where: { userId: req.user!.id },
    select: { id: true, name: true, parentId: true, lockHash: true, lockedAt: true, deletedAt: true },
  })
  const folders = new Map(rows.map((row) => [row.id, row]))
  const unlocked = unlockedFolderIds(req, folders)
  const memo = new Map<string, boolean>()
  const isClosed = (id: string, depth: number): boolean => {
    const known = memo.get(id)
    if (known !== undefined) return known
    const folder = folders.get(id)
    if (!folder || depth > 200) return false
    const closed = (Boolean(folder.lockHash) && !unlocked.has(id)) || (folder.parentId ? isClosed(folder.parentId, depth + 1) : false)
    memo.set(id, closed)
    return closed
  }
  const blocked = new Set([...folders.keys()].filter((id) => isClosed(id, 0)))
  return { folders, blocked, unlocked }
}

export function isFolderBlocked(state: LockState, folderId: string | null | undefined) {
  return Boolean(folderId && state.blocked.has(folderId))
}

// The outermost locked folder that keeps this folder closed: the one the user has to unlock first.
export function blockingFolder(state: LockState, folderId: string | null | undefined) {
  let outermost: FolderNode | undefined
  let current = folderId ? state.folders.get(folderId) : undefined
  for (let depth = 0; current && depth < 200; depth++) {
    if (current.lockHash && !state.unlocked.has(current.id)) outermost = current
    current = current.parentId ? state.folders.get(current.parentId) : undefined
  }
  return outermost
}

export function sendFolderLocked(res: Response, state: LockState, folderId: string | null | undefined) {
  const folder = blockingFolder(state, folderId)
  return res.status(423).json({ code: 'FOLDER_LOCKED', message: 'This folder is locked. Enter its password to open it.', lockedFolderId: folder?.id ?? null, lockedFolderName: folder?.name ?? null })
}

// Prisma filter for files outside closed folders (files at the top level have no folder; NOT IN alone would drop them).
export function openFilesFilter(state: LockState) {
  return state.blocked.size ? { OR: [{ folderId: null }, { folderId: { notIn: [...state.blocked] } }] } : {}
}

// Whether the folder or any folder inside it has a lock of its own.
export function hasLockInside(state: LockState, folderId: string) {
  for (const folder of state.folders.values()) {
    if (!folder.lockHash) continue
    let current: FolderNode | undefined = folder
    for (let depth = 0; current && depth < 200; depth++) {
      if (current.id === folderId) return true
      current = current.parentId ? state.folders.get(current.parentId) : undefined
    }
  }
  return false
}

// Nearest folder that still exists, going up from a (possibly deleted) folder: where a restored file goes back to.
export function nearestExistingFolder(state: LockState, folderId: string | null) {
  let current = folderId ? state.folders.get(folderId) : undefined
  for (let depth = 0; current && depth < 200; depth++) {
    if (!current.deletedAt) return current.id
    current = current.parentId ? state.folders.get(current.parentId) : undefined
  }
  return null
}
