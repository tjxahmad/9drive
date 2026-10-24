// Unlocked folders, kept in memory only: closing or refreshing the app locks every folder again, as does leaving
// the folder (see AllFilesPage) or 15 minutes without any click or key press.
const unlocks = new Map<string, string>()
const IDLE_RELOCK_MS = 15 * 60_000
let lastActivity = Date.now()

export const FOLDERS_RELOCKED_EVENT = '9drive:folders-relocked'

export function setFolderUnlock(folderId: string, token: string | null | undefined) {
  if (token) unlocks.set(folderId, token)
}

export function isFolderUnlocked(folderId: string | null | undefined) {
  return Boolean(folderId && unlocks.has(folderId))
}

// Header value for API requests: the server only opens folders whose unlock it receives.
export function folderUnlockHeader() {
  return [...unlocks.values()].join(',')
}

export function withFolderUnlocks(headers: Record<string, string> = {}) {
  const value = folderUnlockHeader()
  return value ? { ...headers, 'X-Folder-Unlock': value } : headers
}

// Locks every unlocked folder except the given ones (the folders the user is currently inside).
export function keepFolderUnlocks(folderIds: Array<string | undefined | null>) {
  const keep = new Set(folderIds.filter(Boolean))
  for (const id of [...unlocks.keys()]) if (!keep.has(id)) unlocks.delete(id)
}

export function lockAllFolders() {
  if (unlocks.size === 0) return
  unlocks.clear()
  window.dispatchEvent(new Event(FOLDERS_RELOCKED_EVENT))
}

if (typeof window !== 'undefined') {
  const markActive = () => { lastActivity = Date.now() }
  window.addEventListener('pointerdown', markActive, { passive: true })
  window.addEventListener('keydown', markActive)
  window.setInterval(() => { if (unlocks.size && Date.now() - lastActivity > IDLE_RELOCK_MS) lockAllFolders() }, 30_000)
}

export class FolderLockedError extends Error {
  lockedFolderId: string | null
  lockedFolderName: string | null

  constructor(message: string, lockedFolderId: string | null, lockedFolderName: string | null) {
    super(message)
    this.lockedFolderId = lockedFolderId
    this.lockedFolderName = lockedFolderName
  }
}
