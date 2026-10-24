import { useEffect, useState, type DragEvent, type FormEvent, type MouseEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Archive, ClipboardPaste, Download, FolderInput, FolderPlus, LayoutGrid, List, Lock, RefreshCw, Star, Trash2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DummyModal } from '@/components/drive/DummyModal'
import { EmptyAreaContextMenu } from '@/components/drive/EmptyAreaContextMenu'
import { FileContextMenu } from '@/components/drive/FileContextMenu'
import { FileDetailsDrawer } from '@/components/drive/FileDetailsDrawer'
import { FileGrid } from '@/components/drive/FileGrid'
import { FileTable } from '@/components/drive/FileTable'
import { FolderContextMenu } from '@/components/drive/FolderContextMenu'
import { FolderGrid, type FolderSizeScale } from '@/components/drive/FolderGrid'
import { defaultFolderColor, defaultFolderIconUrl, FolderIconGlyph, folderColorOptions, folderIconOptions, normalizeFolderColor } from '@/components/drive/FolderVisual'
import { PageHeader } from '@/components/drive/PageHeader'
import { Input } from '@/components/ui/input'
import { API_URL, apiFetch, formatBytes, formatDate } from '@/lib/api'
import { canSaveFolderDirectly, downloadFile as downloadFileById, downloadFilesAsZip, downloadFolderAsZip, saveFolderToDisk } from '@/lib/downloads'
import { FOLDERS_RELOCKED_EVENT, FolderLockedError, isFolderUnlocked, keepFolderUnlocks, lockAllFolders, setFolderUnlock } from '@/lib/folderLocks'
import { MediaViewer } from '@/components/drive/MediaViewer'
import { drivePreviewUrl, getPreviewKind } from '@/lib/preview'
import type { FileItem, FolderItem } from '@/data/drive-data'
import { useUpload } from '@/context/UploadContext'
import { useDriveLayoutActions } from '@/layouts/DriveLayout'

type BackendFile = { id: string; name: string; mimeType: string; sizeBytes: string; createdAt: string; folderId?: string | null; connectedAccount?: { email: string; provider: string }; folder?: { id: string; name: string } | null }
type BackendFolder = { id: string; name: string; color: string; iconUrl?: string | null; parentId?: string | null; providerFolderId?: string | null; updatedAt: string; locked?: boolean; unlocked?: boolean }
type ConnectedAccount = { id: string; provider: string; email: string; displayName?: string | null; status: string }

const sizeActiveClasses: Record<FolderSizeScale, string> = {
  xs: 'bg-white text-slate-800 dark:bg-red-500/20 dark:text-red-300 dark:border-red-500/30 shadow-sm dark:shadow-none',
  sm: 'bg-white text-slate-800 dark:bg-orange-500/20 dark:text-orange-300 dark:border-orange-500/30 shadow-sm dark:shadow-none',
  md: 'bg-white text-slate-800 dark:bg-blue-500/20 dark:text-blue-300 dark:border-blue-500/30 shadow-sm dark:shadow-none',
  lg: 'bg-white text-slate-800 dark:bg-purple-500/20 dark:text-purple-300 dark:border-purple-500/30 shadow-sm dark:shadow-none'
}

type FileViewMode = 'list' | 'grid'
type DuplicateName = { name: string; location: string }
type DuplicatePrompt = { files: File[]; duplicates: DuplicateName[]; targetFolderId: string | null; targetAccountId: string | null }
// unlock: open a locked folder; set/change: the folder's own password; remove: needs the 9Drive account password.
type LockDialog = { mode: 'unlock' | 'set' | 'change' | 'remove'; folderId: string; folderName: string; then?: () => void; leaveOnCancel?: boolean }

const lockDialogText: Record<LockDialog['mode'], { title: string; label: string; submit: string }> = {
  unlock: { title: 'Locked folder', label: 'Folder password', submit: 'Open' },
  set: { title: 'Lock folder', label: 'New folder password', submit: 'Lock' },
  change: { title: 'Change lock password', label: 'New folder password', submit: 'Change' },
  remove: { title: 'Remove lock', label: 'Your 9Drive account password', submit: 'Remove lock' },
}

const fileViewStorageKey = '9drive:all-files-view-mode'

function getStoredFileViewMode(): FileViewMode {
  const stored = localStorage.getItem(fileViewStorageKey)
  return stored === 'grid' || stored === 'list' ? stored : 'list'
}

function mimeToKind(mimeType: string): FileItem['kind'] {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.includes('pdf')) return 'pdf'
  return 'doc'
}

function providerLabel(provider: string | undefined) {
  if (provider === 's3') return 'S3 Storage'
  return 'Google Drive'
}

function mapFile(file: BackendFile): FileItem {
  return { id: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes, createdAt: file.createdAt, accountEmail: file.connectedAccount?.email, accountProvider: providerLabel(file.connectedAccount?.provider), date: formatDate(file.createdAt), size: formatBytes(file.sizeBytes), access: file.connectedAccount?.email ?? providerLabel(file.connectedAccount?.provider), kind: mimeToKind(file.mimeType), shared: 1, folderId: file.folderId, folderName: file.folder?.name }
}

function mapFolder(folder: BackendFolder): FolderItem {
  return { id: folder.id, name: folder.name, color: folder.color, iconUrl: folder.iconUrl, parentId: folder.parentId, providerFolderId: folder.providerFolderId, updated: `Updated ${formatDate(folder.updatedAt)}`, locked: folder.locked, unlocked: folder.unlocked }
}



function FolderAppearanceFields({ color, iconUrl, onColorChange, onIconChange }: { color: string; iconUrl: string; onColorChange: (color: string) => void; onIconChange: (iconUrl: string) => void }) {
  const normalizedColor = normalizeFolderColor(color)
  return (
    <div className="grid gap-4">
      <label className="grid gap-2 text-sm font-semibold">Folder Color<Input type="color" value={normalizedColor} onChange={(event) => onColorChange(event.target.value)} className="h-12 p-1" /></label>
      <div className="flex flex-wrap gap-2">{folderColorOptions.map((option) => <button key={option} type="button" onClick={() => onColorChange(option)} className={normalizedColor === option ? 'h-8 w-8 rounded-lg border-2 border-blue-600' : 'h-8 w-8 rounded-lg border border-slate-200'} style={{ backgroundColor: option }} aria-label={`Use ${option} folder color`} />)}</div>
      <div className="grid gap-2 text-sm font-semibold"><span>Folder Icon</span><div className="grid grid-cols-4 gap-2 sm:grid-cols-8">{folderIconOptions.map((option) => <button key={option.url} type="button" onClick={() => onIconChange(option.url)} className={iconUrl === option.url ? 'flex h-12 items-center justify-center rounded-xl border-2 border-blue-600 bg-blue-50 p-2' : 'flex h-12 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 p-2 hover:bg-slate-100'} title={option.label} aria-label={`Use ${option.label} icon`}><FolderIconGlyph iconUrl={option.url} color={normalizedColor} className="h-6 w-6" /></button>)}</div></div>
    </div>
  )
}

export function AllFilesPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const activeFolderId = searchParams.get('folderId')
  const searchQuery = searchParams.get('q')?.trim() ?? ''
  const [uploadOpen, setUploadOpen] = useState(false)
  const [folderOpen, setFolderOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [folderRenameOpen, setFolderRenameOpen] = useState(false)
  const [folderDeleteOpen, setFolderDeleteOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [files, setFiles] = useState<FileItem[]>([])
  const [folders, setFolders] = useState<FolderItem[]>([])
  const [folderCovers, setFolderCovers] = useState<Record<string, string[]>>({})
  const [allFolders, setAllFolders] = useState<FolderItem[]>([])
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [duplicatePrompt, setDuplicatePrompt] = useState<DuplicatePrompt | null>(null)
  const [selectedFolderId, setSelectedFolderId] = useState('')
  const [isUploadDragging, setIsUploadDragging] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [folderColor, setFolderColor] = useState(defaultFolderColor)
  const [folderIconUrl, setFolderIconUrl] = useState(defaultFolderIconUrl)
  const [renameValue, setRenameValue] = useState('')
  const [folderRenameValue, setFolderRenameValue] = useState('')
  const [folderRenameColor, setFolderRenameColor] = useState(defaultFolderColor)
  const [folderRenameIconUrl, setFolderRenameIconUrl] = useState(defaultFolderIconUrl)
  const [activeFile, setActiveFile] = useState<FileItem | null>(null)
  const [activeFolderForMenu, setActiveFolderForMenu] = useState<FolderItem | null>(null)
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set())
  const [cutFolder, setCutFolder] = useState<FolderItem | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileItem | null }>({ x: 0, y: 0, file: null })
  const [folderContextMenu, setFolderContextMenu] = useState<{ x: number; y: number; folder: FolderItem | null }>({ x: 0, y: 0, folder: null })
  const [emptyContextMenu, setEmptyContextMenu] = useState<{ x: number; y: number; open: boolean }>({ x: 0, y: 0, open: false })
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [syncingDrive, setSyncingDrive] = useState(false)
  const [fileViewMode, setFileViewMode] = useState<FileViewMode>(getStoredFileViewMode)
  const { uploadFiles, uploadProgress } = useUpload()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('viewer')
  const [inviteTargetType, setInviteTargetType] = useState<'file' | 'folder'>('file')
  const [inviteTargetId, setInviteTargetId] = useState('')
  const [inviteMessage, setInviteMessage] = useState('')
  const [inviting, setInviting] = useState(false)
  const [folderSizeScale, setFolderSizeScale] = useState<FolderSizeScale>(() => {
    const v = localStorage.getItem('9drive:folder-size')
    return (v === 'xs' || v === 'sm' || v === 'md' || v === 'lg') ? v : 'md'
  })
  const { setHeaderActions } = useDriveLayoutActions()
  const [connectedAccounts, setConnectedAccounts] = useState<ConnectedAccount[]>([])
  const [selectedTargetAccountId, setSelectedTargetAccountId] = useState('')
  const [lockDialog, setLockDialog] = useState<LockDialog | null>(null)
  const [lockPassword, setLockPassword] = useState('')
  const [lockPasswordConfirm, setLockPasswordConfirm] = useState('')
  const [lockCurrentPassword, setLockCurrentPassword] = useState('')
  const [lockError, setLockError] = useState('')
  const [lockBusy, setLockBusy] = useState(false)

  function flash(text: string, ms = 4000) {
    setMessage(text)
    setTimeout(() => setMessage((current) => (current === text ? '' : current)), ms)
  }

  // The folder and the folders around it, outermost first.
  function folderChain(folderId: string | null) {
    const foldersById = new Map(allFolders.map((folder) => [folder.id, folder]))
    const chain: FolderItem[] = []
    const visited = new Set<string>()
    let current = folderId ? foldersById.get(folderId) : undefined
    while (current?.id && !visited.has(current.id)) {
      chain.unshift(current)
      visited.add(current.id)
      current = current.parentId ? foldersById.get(current.parentId) : undefined
    }
    return chain
  }

  function handleLoadError(error: unknown) {
    if (error instanceof FolderLockedError && error.lockedFolderId) {
      // Opened by a link, or the folder locked again: ask for its password (Cancel goes back out of it).
      askToUnlock(error.lockedFolderId, error.lockedFolderName ?? 'Locked folder', () => { loadAll().catch(handleLoadError) }, true)
      return
    }
    setMessage(error instanceof Error ? error.message : 'Failed to load files')
  }

  function openLockDialog(dialog: LockDialog) {
    setLockPassword('')
    setLockPasswordConfirm('')
    setLockCurrentPassword('')
    setLockError('')
    setLockDialog(dialog)
    setFolderContextMenu({ x: 0, y: 0, folder: null })
  }

  function askToUnlock(folderId: string, folderName: string, then?: () => void, leaveOnCancel = false) {
    openLockDialog({ mode: 'unlock', folderId, folderName, then, leaveOnCancel })
  }

  function closeLockDialog() {
    const dialog = lockDialog
    setLockDialog(null)
    if (dialog?.leaveOnCancel) {
      const parentId = allFolders.find((folder) => folder.id === dialog.folderId)?.parentId
      if (parentId) openFolderById(parentId)
      else closeFolder()
    }
  }

  async function submitLockDialog(event: FormEvent) {
    event.preventDefault()
    const dialog = lockDialog
    if (!dialog) return
    if ((dialog.mode === 'set' || dialog.mode === 'change') && lockPassword !== lockPasswordConfirm) {
      setLockError('The two passwords are not the same.')
      return
    }
    // Locking a folder from outside should not leave it open; from inside, it stays open until you leave.
    const insideFolder = folderChain(activeFolderId).some((folder) => folder.id === dialog.folderId)
    setLockBusy(true)
    setLockError('')
    try {
      if (dialog.mode === 'unlock') {
        const data = await apiFetch<{ unlockToken: string | null }>(`/folders/${dialog.folderId}/unlock`, { method: 'POST', body: JSON.stringify({ password: lockPassword }) })
        setFolderUnlock(dialog.folderId, data.unlockToken)
      } else if (dialog.mode === 'set') {
        const data = await apiFetch<{ unlockToken: string }>(`/folders/${dialog.folderId}/lock`, { method: 'POST', body: JSON.stringify({ password: lockPassword }) })
        if (insideFolder) setFolderUnlock(dialog.folderId, data.unlockToken)
        flash(`"${dialog.folderName}" is locked. It opens only with its password.`)
      } else if (dialog.mode === 'change') {
        const data = await apiFetch<{ unlockToken: string }>(`/folders/${dialog.folderId}/lock`, { method: 'PATCH', body: JSON.stringify({ currentPassword: lockCurrentPassword, newPassword: lockPassword }) })
        if (insideFolder) setFolderUnlock(dialog.folderId, data.unlockToken)
        flash(`Lock password of "${dialog.folderName}" changed.`)
      } else {
        await apiFetch(`/folders/${dialog.folderId}/remove-lock`, { method: 'POST', body: JSON.stringify({ accountPassword: lockPassword }) })
        flash(`Lock removed from "${dialog.folderName}".`)
      }
      setLockDialog(null)
      if (dialog.then) dialog.then()
      else await loadAll()
    } catch (error) {
      setLockError(error instanceof Error ? error.message : 'Something went wrong.')
    } finally {
      setLockBusy(false)
    }
  }

  // A folder action hit a locked folder: ask for its password, then try the action again.
  function handleFolderActionError(error: unknown, retry: () => void) {
    if (error instanceof FolderLockedError && error.lockedFolderId) {
      askToUnlock(error.lockedFolderId, error.lockedFolderName ?? 'Locked folder', retry)
      return
    }
    setMessage(error instanceof Error ? error.message : 'Something went wrong.')
  }

  async function downloadFolderZip(folder: FolderItem | null) {
    if (!folder?.id) return
    setFolderContextMenu({ x: 0, y: 0, folder: null })
    try {
      const data = await downloadFolderAsZip(folder.id)
      flash(`"${folder.name}" (${data.count} file${data.count === 1 ? '' : 's'}) is downloading as a ZIP. Progress shows in your browser's downloads.${data.lockedSubfolders ? ` ${data.lockedSubfolders} locked folder(s) inside were left out.` : ''}`, 7000)
    } catch (error) {
      handleFolderActionError(error, () => { downloadFolderZip(folder).catch(() => undefined) })
    }
  }

  // Saves the folder as a normal folder (no ZIP) where the user chooses; on phones, one download per file.
  async function downloadFolderPlain(folder: FolderItem | null) {
    if (!folder?.id) return
    setFolderContextMenu({ x: 0, y: 0, folder: null })
    try {
      const listing = await saveFolderToDisk(folder.id, (progress) => setMessage(`Saving "${folder.name}": ${progress.doneFiles} of ${progress.totalFiles} files (${formatBytes(progress.doneBytes)} of ${formatBytes(progress.totalBytes)}). Keep 9Drive open until it finishes.`))
      if (!listing) {
        setMessage('')
        return
      }
      const skipped = listing.lockedSubfolders ? ` ${listing.lockedSubfolders} locked folder(s) inside were left out.` : ''
      if (listing.files.length === 0) flash(`"${folder.name}" has no files to download.${skipped}`)
      else flash(canSaveFolderDirectly() ? `Saved "${folder.name}" (${listing.files.length} files).${skipped}` : `Started ${listing.files.length} downloads from "${folder.name}".${skipped}`, 7000)
    } catch (error) {
      handleFolderActionError(error, () => { downloadFolderPlain(folder).catch(() => undefined) })
    }
  }

  function lockNow() {
    lockAllFolders()
  }

  function changeFolderSize(scale: FolderSizeScale) {
    setFolderSizeScale(scale)
    localStorage.setItem('9drive:folder-size', scale)
  }

  async function loadFiles() {
    const params = new URLSearchParams()
    if (activeFolderId) params.set('folderId', activeFolderId)
    if (searchQuery) params.set('q', searchQuery)

    // Add advanced search filters
    const kind = searchParams.get('kind')
    const accountId = searchParams.get('accountId')
    const minSize = searchParams.get('minSize')
    const maxSize = searchParams.get('maxSize')
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')

    if (kind) params.set('kind', kind)
    if (accountId) params.set('accountId', accountId)
    if (minSize) params.set('minSize', minSize)
    if (maxSize) params.set('maxSize', maxSize)
    if (startDate) params.set('startDate', startDate)
    if (endDate) params.set('endDate', endDate)

    const query = params.toString()
    const path = query ? `/files?${query}` : '/files'
    const data = await apiFetch<{ files: BackendFile[] }>(path)
    setFiles(data.files.map(mapFile))
  }

  async function loadFolders() {
    const visiblePath = activeFolderId ? `/folders?parentId=${activeFolderId}` : '/folders'
    const [visibleData, allData] = await Promise.all([
      apiFetch<{ folders: BackendFolder[] }>(visiblePath),
      apiFetch<{ folders: BackendFolder[] }>('/folders?all=1'),
    ])
    setFolders(visibleData.folders.map(mapFolder))
    setAllFolders(allData.folders.map(mapFolder))
    apiFetch<{ covers: Record<string, string[]> }>('/folders/covers').then((data) => setFolderCovers(data.covers)).catch(() => undefined)
  }

  async function loadAll() {
    await Promise.all([loadFiles(), loadFolders()])
  }

  async function handleDropItem(fileId: string, targetFolderId: string) {
    const fileIds = selectedFileIds.has(fileId) ? Array.from(selectedFileIds) : [fileId]
    setLoading(true)
    setMessage('')
    try {
      await apiFetch('/files/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds, folderId: targetFolderId })
      })
      setMessage(`Successfully moved ${fileIds.length} item(s).`)
      loadAll().catch(() => undefined)
      setSelectedFileIds(new Set())
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to move items')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Leaving a locked folder locks it again: only the folders we are now inside stay unlocked.
    keepFolderUnlocks(folderChain(activeFolderId).map((folder) => folder.id))
    loadAll().catch(handleLoadError)
    setSelectedFileIds(new Set())
  }, [activeFolderId, searchQuery])

  // Idle for a while (or "Lock now"): step out of any locked folder.
  useEffect(() => {
    function onRelocked() {
      setPreviewOpen(false)
      const outermostLocked = folderChain(activeFolderId).find((folder) => folder.locked)
      if (!outermostLocked) loadAll().catch(handleLoadError)
      else if (outermostLocked.parentId) openFolderById(outermostLocked.parentId)
      else closeFolder()
    }
    window.addEventListener(FOLDERS_RELOCKED_EVENT, onRelocked)
    return () => window.removeEventListener(FOLDERS_RELOCKED_EVENT, onRelocked)
  }, [activeFolderId, allFolders, searchQuery])

  useEffect(() => {
    async function loadConnectedAccounts() {
      try {
        const data = await apiFetch<{ accounts: ConnectedAccount[] }>('/connected-accounts')
        setConnectedAccounts(data.accounts || [])
      } catch (error) {
        console.error('Failed to load connected accounts:', error)
      }
    }
    loadConnectedAccounts()
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setContextMenu({ x: 0, y: 0, file: null })
      if (event.key === 'Escape') setFolderContextMenu({ x: 0, y: 0, folder: null })
      if (event.key === 'Escape') setEmptyContextMenu({ x: 0, y: 0, open: false })
      if (event.ctrlKey && event.key.toLowerCase() === 'x' && activeFolderForMenu) {
        event.preventDefault()
        cutSelectedFolder(activeFolderForMenu)
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'v' && cutFolder) {
        event.preventDefault()
        pasteFolder().catch((error) => setMessage(error instanceof Error ? error.message : 'Failed to paste folder'))
      }
    }

    function onOpenMoveShortcut(e: Event) {
      const file = (e as CustomEvent).detail as FileItem
      setActiveFile(file)
      setSelectedFolderId(file.folderId || '')
      setMoveOpen(true)
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('9drive:open-move-modal', onOpenMoveShortcut)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('9drive:open-move-modal', onOpenMoveShortcut)
    }
  }, [activeFolderForMenu, cutFolder, activeFolderId])

  async function createFolder(event: FormEvent) {
    event.preventDefault()
    await apiFetch('/folders', { method: 'POST', body: JSON.stringify({ name: folderName, color: folderColor, iconUrl: folderIconUrl, parentId: activeFolderId ?? null }) })
    setFolderName('')
    setFolderColor(defaultFolderColor)
    setFolderIconUrl(defaultFolderIconUrl)
    setFolderOpen(false)
    await loadFolders()
  }

  async function uploadFile(event: FormEvent) {
    event.preventDefault()
    if (selectedFiles.length === 0) return
    setLoading(true)
    setMessage('')

    const uploadingFiles = [...selectedFiles]
    const targetFolderId = activeFolderId || selectedFolderId
    const targetAccountId = selectedTargetAccountId || null

    setSelectedFiles([])
    setSelectedFolderId('')
    setSelectedTargetAccountId('')
    setUploadOpen(false)

    // Ask before uploading files whose name already exists in 9Drive (or is uploading right now).
    const duplicates = await findDuplicateNames(uploadingFiles)
    if (duplicates.length > 0) {
      setDuplicatePrompt({ files: uploadingFiles, duplicates, targetFolderId: targetFolderId || null, targetAccountId })
      setLoading(false)
      return
    }
    await startUpload(uploadingFiles, targetFolderId || null, targetAccountId)
  }

  // Uploads run in the background (progress panel), so more files can be added while a big upload is running.
  async function startUpload(files: File[], targetFolderId: string | null, targetAccountId: string | null) {
    if (files.length === 0) return
    setLoading(false)
    uploadFiles(files, targetFolderId, targetAccountId).catch((err) => console.error('Upload initiation failed:', err))
  }

  async function findDuplicateNames(files: File[]): Promise<DuplicateName[]> {
    const existing = new Map<string, string>()
    try {
      const data = await apiFetch<{ files: Array<{ name: string; folder?: { name: string } | null }> }>('/files')
      for (const file of data.files) existing.set(file.name.toLowerCase(), file.folder?.name ? `in folder "${file.folder.name}"` : 'in All Files')
    } catch {
      // If the list can't be loaded, upload without the check rather than blocking.
    }
    for (const file of uploadProgress.files) {
      if (file.status === 'uploading' || file.status === 'waiting') existing.set(file.name.toLowerCase(), 'uploading right now')
    }
    return files.filter((file) => existing.has(file.name.toLowerCase())).map((file) => ({ name: file.name, location: existing.get(file.name.toLowerCase()) ?? '' }))
  }

  function answerDuplicatePrompt(choice: 'all' | 'skip' | 'cancel') {
    const prompt = duplicatePrompt
    setDuplicatePrompt(null)
    if (!prompt || choice === 'cancel') return
    const duplicateNames = new Set(prompt.duplicates.map((duplicate) => duplicate.name))
    const files = choice === 'all' ? prompt.files : prompt.files.filter((file) => !duplicateNames.has(file.name))
    if (files.length === 0) {
      setMessage('Nothing uploaded: all selected files already exist.')
      setTimeout(() => setMessage(''), 2500)
      return
    }
    startUpload(files, prompt.targetFolderId, prompt.targetAccountId).catch(() => undefined)
  }


  async function syncGoogleDrive() {
    setSyncingDrive(true)
    setMessage('')
    try {
      const response = await apiFetch<{ results: { created: number; updated: number; deleted: number }[] }>('/files/sync-google', { method: 'POST', body: JSON.stringify({}) })

      let created = 0, updated = 0, deleted = 0
      for (const res of response.results) {
        created += res.created
        updated += res.updated
        deleted += res.deleted
      }
      const accounts = response.results.length

      setMessage(`Google Drive synced. ${created} added, ${updated} updated, ${deleted} removed across ${accounts} account${accounts === 1 ? '' : 's'}.`)
      await loadAll()
      window.dispatchEvent(new Event('9drive:storage-changed'))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to sync Google Drive')
    } finally {
      setSyncingDrive(false)
    }
  }

  function selectUploadFiles(files: FileList | File[] | null | undefined) {
    if (!files) return
    const nextFiles = Array.from(files)
    if (nextFiles.length === 0) return
    setSelectedFiles(nextFiles)
  }

  function removeUploadFile(index: number) {
    setSelectedFiles((files) => files.filter((_, fileIndex) => fileIndex !== index))
  }

  function handleUploadDrag(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (event.type === 'dragenter' || event.type === 'dragover') setIsUploadDragging(true)
    if (event.type === 'dragleave' || event.type === 'drop') setIsUploadDragging(false)
    if (event.type === 'drop') selectUploadFiles(event.dataTransfer.files)
  }



  function openContext(event: MouseEvent<HTMLElement>, file: FileItem) {
    event.preventDefault()
    event.stopPropagation()
    setActiveFile(file)
    setContextMenu({ x: event.clientX, y: event.clientY, file })
  }

  function toggleFileSelection(file: FileItem) {
    if (!file.id) return
    setSelectedFileIds((current) => {
      const next = new Set(current)
      if (next.has(file.id!)) next.delete(file.id!)
      else next.add(file.id!)
      return next
    })
  }

  function toggleAllVisibleFiles() {
    const visibleIds = files.map((file) => file.id).filter(Boolean) as string[]
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedFileIds.has(id))
    setSelectedFileIds(allSelected ? new Set() : new Set(visibleIds))
  }

  function clearSelection() {
    setSelectedFileIds(new Set())
  }

  function changeFileViewMode(mode: FileViewMode) {
    setFileViewMode(mode)
    localStorage.setItem(fileViewStorageKey, mode)
  }

  function openFolderMenu(event: MouseEvent<HTMLElement>, folder: FolderItem) {
    event.preventDefault()
    event.stopPropagation()
    setActiveFolderForMenu(folder)
    setFolderContextMenu({ x: event.clientX, y: event.clientY, folder })
  }

  function openFolder(folder: FolderItem) {
    const folderId = folder.id
    if (!folderId) return
    const open = () => setSearchParams(searchQuery ? { folderId, q: searchQuery } : { folderId })
    if (folder.locked && !isFolderUnlocked(folderId)) {
      askToUnlock(folderId, folder.name, open)
      return
    }
    open()
  }

  function openFolderById(folderId: string) {
    setSearchParams(searchQuery ? { folderId, q: searchQuery } : { folderId })
  }

  function openEmptyContextMenu(event: MouseEvent<HTMLElement>) {
    event.preventDefault()
    setEmptyContextMenu({ x: event.clientX, y: event.clientY, open: true })
  }

  function closeFolder() {
    setSearchParams(searchQuery ? { q: searchQuery } : {})
  }

  async function viewFile() {
    if (!activeFile?.id) return
    setPreviewUrl('')
    setPreviewError('')
    setPreviewLoading(true)
    setPreviewOpen(true)
    setContextMenu({ x: 0, y: 0, file: null })
    try {
      if (getPreviewKind(activeFile.mimeType) === 'office') {
        // Office files open in Google Drive's own viewer: private to the owning Google account, not sent to any other site.
        const viewData = await apiFetch<{ url: string | null }>(`/files/${activeFile.id}/view-url?preview=1`)
        if (!viewData.url) throw new Error('Preview is not available for this file. Download it to open.')
        setPreviewUrl(drivePreviewUrl(viewData.url, activeFile.accountEmail))
        return
      }
      const data = await apiFetch<{ path?: string; url: string }>(`/files/${activeFile.id}/preview-token`, { method: 'POST' })
      const previewPath = data.path ?? new URL(data.url).pathname
      setPreviewUrl(`${API_URL}${previewPath}`)
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Failed to load preview')
    } finally {
      setPreviewLoading(false)
    }
  }

  // The browser downloads the file itself (straight to disk, with its own progress bar), so a big video starts
  // downloading at once instead of after minutes of silence.
  async function downloadFile() {
    if (!activeFile?.id) return
    setContextMenu({ x: 0, y: 0, file: null })
    await downloadFileById(activeFile.id)
    flash(`Downloading "${activeFile.name}". Progress shows in your browser's downloads.`)
  }

  async function downloadBatchAsZip() {
    const selectedIds = [...selectedFileIds]
    if (selectedIds.length === 0) return
    setMessage('')
    try {
      await downloadFilesAsZip(selectedIds)
      clearSelection()
      flash(`ZIP of ${selectedIds.length} file${selectedIds.length === 1 ? '' : 's'} is downloading. Progress shows in your browser's downloads.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Batch download failed')
    }
  }


  async function renameFile(event: FormEvent) {
    event.preventDefault()
    if (!activeFile?.id) return
    await apiFetch(`/files/${activeFile.id}`, { method: 'PATCH', body: JSON.stringify({ name: renameValue }) })
    setRenameOpen(false)
    await loadFiles()
  }

  async function moveFile(event: FormEvent) {
    event.preventDefault()
    const selectedIds = [...selectedFileIds]
    if (selectedIds.length > 0) await apiFetch('/files/batch', { method: 'PATCH', body: JSON.stringify({ fileIds: selectedIds, folderId: selectedFolderId || null }) })
    else if (activeFile?.id) await apiFetch(`/files/${activeFile.id}`, { method: 'PATCH', body: JSON.stringify({ folderId: selectedFolderId || null }) })
    else return
    setMoveOpen(false)
    setSelectedFolderId('')
    clearSelection()
    await loadFiles()
  }

  async function deleteFile() {
    const selectedIds = [...selectedFileIds]
    if (selectedIds.length > 0) await apiFetch('/files/batch', { method: 'DELETE', body: JSON.stringify({ fileIds: selectedIds }) })
    else if (activeFile?.id) await apiFetch(`/files/${activeFile.id}`, { method: 'DELETE' })
    else return
    setDeleteOpen(false)
    clearSelection()
    await loadFiles()
    window.dispatchEvent(new Event('9drive:storage-changed'))
  }

  // Public share links are disabled: only the owner can read or write files.
  function shareFile() {
    setMessage('Public share links are disabled. Only you can access your files.')
    setTimeout(() => setMessage(''), 2500)
    setContextMenu({ x: 0, y: 0, file: null })
  }

  async function copyShareLinkDirect() {
    if (!activeFile?.id) return
    try {
      const data = await apiFetch<{ url: string | null }>(`/files/${activeFile.id}/view-url`)
      if (data.url) {
        await navigator.clipboard.writeText(data.url)
        setMessage('Private Google Drive link copied (opens only for your Google account).')
        setTimeout(() => setMessage(''), 2500)
      } else {
        setMessage('No private link is available for this file.')
        setTimeout(() => setMessage(''), 2500)
      }
    } catch (err: any) {
      setMessage('Failed to copy link: ' + (err.message || err))
      setTimeout(() => setMessage(''), 2500)
    }
    setContextMenu({ x: 0, y: 0, file: null })
  }

  async function inviteToFile() {
    if (!activeFile?.id) return
    setInviteTargetType('file')
    setInviteTargetId(activeFile.id)
    setInviteOpen(true)
    setContextMenu({ x: 0, y: 0, file: null })
  }

  async function inviteToFolder() {
    if (!activeFolderForMenu?.id) return
    setInviteTargetType('folder')
    setInviteTargetId(activeFolderForMenu.id)
    setInviteOpen(true)
    setFolderContextMenu({ x: 0, y: 0, folder: null })
  }

  async function copyFolderLink() {
    if (!activeFolderForMenu?.id) return
    let url = `${window.location.origin}/all-files?folderId=${activeFolderForMenu.id}`
    if (activeFolderForMenu.providerFolderId) {
      url = `https://drive.google.com/open?id=${activeFolderForMenu.providerFolderId}`
    }
    await navigator.clipboard.writeText(url)
    setMessage('Folder link copied to clipboard!')
    setTimeout(() => setMessage(''), 2500)
    setFolderContextMenu({ x: 0, y: 0, folder: null })
  }

  async function sendInvite(event: FormEvent) {
    event.preventDefault()
    if (!inviteTargetId) return
    setInviting(true)
    setInviteMessage('')
    try {
      await apiFetch('/invites', { method: 'POST', body: JSON.stringify({ email: inviteEmail, role: inviteRole, targetType: inviteTargetType, targetId: inviteTargetId }) })
      setInviteEmail('')
      setInviteRole('viewer')
      setInviteMessage('Invite saved. Member will appear in Shared.')
      window.dispatchEvent(new Event('9drive:invites-changed'))
    } catch (error) {
      setInviteMessage(error instanceof Error ? error.message : 'Failed to send invite')
    } finally {
      setInviting(false)
    }
  }

  async function renameFolder(event: FormEvent) {
    event.preventDefault()
    if (!activeFolderForMenu?.id) return
    try {
      await apiFetch(`/folders/${activeFolderForMenu.id}`, { method: 'PATCH', body: JSON.stringify({ name: folderRenameValue, color: folderRenameColor, iconUrl: folderRenameIconUrl }) })
      setFolderRenameOpen(false)
      await loadFolders()
    } catch (error) {
      setFolderRenameOpen(false)
      handleFolderActionError(error, () => setFolderRenameOpen(true))
    }
  }

  async function deleteFolder() {
    if (!activeFolderForMenu?.id) return
    try {
      await apiFetch(`/folders/${activeFolderForMenu.id}`, { method: 'DELETE' })
      setFolderDeleteOpen(false)
      await loadFolders()
    } catch (error) {
      setFolderDeleteOpen(false)
      handleFolderActionError(error, () => setFolderDeleteOpen(true))
    }
  }

  function cutSelectedFolder(folder: FolderItem | null) {
    if (!folder?.id) return
    setCutFolder(folder)
    setFolderContextMenu({ x: 0, y: 0, folder: null })
    setMessage(`Folder "${folder.name}" ready to move. Open target folder and press Ctrl+V.`)
  }

  async function pasteFolder() {
    if (!cutFolder?.id) return
    await apiFetch(`/folders/${cutFolder.id}`, { method: 'PATCH', body: JSON.stringify({ parentId: activeFolderId ?? null }) })
    setMessage(`Folder "${cutFolder.name}" moved.`)
    setCutFolder(null)
    await loadFolders()
  }

  function closePreview() {
    setPreviewUrl('')
    setPreviewError('')
    setPreviewLoading(false)
    setPreviewOpen(false)
  }

  useEffect(() => {
    function handleUploadCompleted() {
      loadAll().catch(() => undefined)
    }
    window.addEventListener('9drive:upload-completed', handleUploadCompleted)
    return () => window.removeEventListener('9drive:upload-completed', handleUploadCompleted)
  }, [activeFolderId])

  useEffect(() => {
    const sizeLabels: FolderSizeScale[] = ['xs', 'sm', 'md', 'lg']
    setHeaderActions(
      <div className="flex items-center gap-2">
        {/* Folder size scale picker */}
        <div className="hidden sm:flex items-center gap-0.5 rounded-xl border border-slate-200 bg-slate-50 p-0.5">
          {sizeLabels.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => changeFolderSize(s)}
              className={[
                'rounded-lg px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition-all border border-transparent',
                folderSizeScale === s
                  ? sizeActiveClasses[s]
                  : 'text-slate-400 hover:text-slate-600',
              ].join(' ')}
              aria-label={`Folder size ${s}`}
              aria-pressed={folderSizeScale === s}
            >
              {s}
            </button>
          ))}
        </div>
        {/* Divider */}
        <div className="hidden sm:block h-6 w-px bg-slate-200" />
        <Button size="sm" onClick={() => setUploadOpen(true)}>
          <Upload className="h-3.5 w-3.5" />Upload
        </Button>
        <Button size="sm" variant="outline" onClick={() => setFolderOpen(true)}>
          <FolderPlus className="h-3.5 w-3.5" />New Folder
        </Button>
        <Button size="sm" variant="outline" disabled={syncingDrive} onClick={syncGoogleDrive}>
          <RefreshCw className={syncingDrive ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          {syncingDrive ? 'Syncing...' : 'Sync'}
        </Button>
      </div>
    )
  }, [syncingDrive, folderSizeScale])


  const recentFolders = folders.slice(0, 4)
  const moreFolders = folders.slice(4)
  const activeFolder = allFolders.find((folder) => folder.id === activeFolderId)
  const folderBreadcrumbs = activeFolder ? folderChain(activeFolderId) : []
  const insideLockedFolder = folderBreadcrumbs.some((folder) => folder.locked)
  const lockText = lockDialog ? lockDialogText[lockDialog.mode] : null
  const allVisibleSelected = files.length > 0 && files.every((file) => file.id && selectedFileIds.has(file.id))
  const activePreviewKind = getPreviewKind(activeFile?.mimeType)

  return (
    <>
      <div onContextMenu={openEmptyContextMenu} className="min-h-[620px] w-full min-w-0">
      <PageHeader title={activeFolder ? <span className="block min-w-0 truncate"><button className="text-blue-600 hover:underline" onClick={closeFolder}>All Files</button>{folderBreadcrumbs.map((folder, index) => <span key={folder.id}><span className="text-slate-400"> / </span>{index === folderBreadcrumbs.length - 1 ? <span>{folder.name}</span> : <button className="text-blue-600 hover:underline" onClick={() => folder.id && openFolderById(folder.id)}>{folder.name}</button>}</span>)}</span> : 'All Files'} />
      {/* Action buttons row — visible on mobile/tablet, hidden on desktop (desktop uses header slot) */}
      <div className="mt-4 flex flex-wrap items-center gap-2 lg:hidden">
        <Button size="sm" onClick={() => setUploadOpen(true)}><Upload className="h-3.5 w-3.5" />Upload</Button>
        <Button size="sm" variant="outline" onClick={() => setFolderOpen(true)}><FolderPlus className="h-3.5 w-3.5" />New Folder</Button>
        <Button size="sm" variant="outline" disabled={syncingDrive} onClick={syncGoogleDrive}><RefreshCw className={syncingDrive ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />{syncingDrive ? 'Syncing...' : 'Sync'}</Button>
        <div className="flex items-center gap-0.5 rounded-xl border border-slate-200 bg-slate-50 p-0.5">
          {(['xs','sm','md','lg'] as FolderSizeScale[]).map((s) => (
            <button key={s} type="button" onClick={() => changeFolderSize(s)} className={['rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-all border border-transparent', folderSizeScale === s ? sizeActiveClasses[s] : 'text-slate-400 hover:text-slate-600'].join(' ')} aria-label={`Folder size ${s}`}>{s}</button>
          ))}
        </div>
      </div>
      {message ? <p className="mt-3 rounded-xl bg-blue-50 p-3 text-sm text-blue-700">{message}</p> : null}
      {insideLockedFolder ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-semibold dark:border-amber-500/30 dark:bg-amber-500/10">
          <span className="flex items-center gap-2 text-amber-800 dark:text-amber-200"><Lock className="h-4 w-4 shrink-0" />Locked folder, open for now. It locks again when you leave it.</span>
          <Button size="sm" variant="outline" onClick={lockNow}><Lock className="h-3.5 w-3.5" />Lock now</Button>
        </div>
      ) : null}
      {!activeFolder && (recentFolders.length > 0 ? <FolderGrid items={recentFolders} covers={folderCovers} mobileTwoColumns sizeScale={folderSizeScale} onFolderMenu={openFolderMenu} onFolderOpen={openFolder} onDropItem={handleDropItem} /> : <p className="mt-4 rounded-xl bg-slate-50 p-5 text-sm text-slate-500">No folders yet. Click New Folder to organize uploads.</p>)}
      {!activeFolder && moreFolders.length > 0 ? <>
        <h2 className="mt-4 font-extrabold text-slate-700">More Folders</h2>
        <FolderGrid items={moreFolders} covers={folderCovers} sizeScale={folderSizeScale} onFolderMenu={openFolderMenu} onFolderOpen={openFolder} onDropItem={handleDropItem} />
      </> : null}
      {activeFolder && folders.length > 0 ? <>
        <h2 className="mt-4 font-extrabold text-slate-700">Folders</h2>
        <FolderGrid items={folders} covers={folderCovers} sizeScale={folderSizeScale} onFolderMenu={openFolderMenu} onFolderOpen={openFolder} onDropItem={handleDropItem} />
      </> : null}
      <div className="mt-4 flex flex-col gap-2 sm:mt-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3"><Button variant="soft" className="hidden sm:inline-flex"><Archive className="h-4 w-4" />Recents</Button><Button variant="soft" className="hidden sm:inline-flex"><Star className="h-4 w-4" />Starred</Button>{selectedFileIds.size > 0 ? <div className="flex w-full flex-col gap-3 rounded-2xl border border-orange-500/20 bg-orange-500/10 p-3 sm:w-auto sm:flex-row sm:items-center sm:border-0 sm:bg-transparent sm:p-0"><span className="text-sm font-extrabold text-slate-700">{selectedFileIds.size} selected</span><div className="grid grid-cols-4 gap-2 sm:flex sm:gap-3"><Button className="w-full" variant="outline" onClick={downloadBatchAsZip}><Download className="h-4 w-4" />ZIP</Button><Button className="w-full" variant="outline" onClick={() => setMoveOpen(true)}><FolderInput className="h-4 w-4" />Move</Button><Button className="w-full" variant="danger" onClick={() => setDeleteOpen(true)}><Trash2 className="h-4 w-4" />Delete</Button><Button className="w-full" variant="ghost" onClick={clearSelection}>Clear</Button></div></div> : null}</div>
        <div className="flex gap-3"><Button variant={fileViewMode === 'grid' ? 'soft' : 'outline'} size="icon" aria-label="Show files as grid" aria-pressed={fileViewMode === 'grid'} onClick={() => changeFileViewMode('grid')}><LayoutGrid className="h-5 w-5" /></Button><Button variant={fileViewMode === 'list' ? 'soft' : 'outline'} size="icon" aria-label="Show files as list" aria-pressed={fileViewMode === 'list'} onClick={() => changeFileViewMode('list')}><List className="h-5 w-5" /></Button></div>
      </div>
      {cutFolder ? <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-700"><ClipboardPaste className="mr-2 inline h-4 w-4" />Cut folder: {cutFolder.name}. Press Ctrl+V or right-click empty area to paste here.</p> : null}
      {files.length === 0 ? (
        <Card className="mt-3 p-5 bg-white/10 backdrop-blur-sm border border-white/20 dark:bg-transparent dark:border-0 dark:p-0 dark:shadow-none">
          <p className="text-sm text-slate-500">{searchQuery ? `No files found for "${searchQuery}".` : activeFolder ? 'No files in this folder yet.' : 'No uploaded files yet. Connect Google Drive in Settings, then upload a file.'}</p>
        </Card>
      ) : (
        <Card className="mt-3 p-4 sm:p-5 bg-white/10 backdrop-blur-sm border border-white/20 dark:bg-transparent dark:border-0 dark:p-0 dark:shadow-none">
          {fileViewMode === 'grid' ? (
            <FileGrid files={files} selectedFileIds={selectedFileIds} sizeScale={folderSizeScale} onToggleFile={toggleFileSelection} onFileContextMenu={openContext} />
          ) : (
            <FileTable files={files} selectedFileIds={selectedFileIds} allSelected={allVisibleSelected} onToggleFile={toggleFileSelection} onToggleAll={toggleAllVisibleFiles} onFileContextMenu={openContext} />
          )}
        </Card>
      )}
      </div>
      <EmptyAreaContextMenu x={emptyContextMenu.x} y={emptyContextMenu.y} open={emptyContextMenu.open} canPasteFolder={Boolean(cutFolder)} onClose={() => setEmptyContextMenu({ x: 0, y: 0, open: false })} onUpload={() => { setUploadOpen(true); setEmptyContextMenu({ x: 0, y: 0, open: false }) }} onCreateFolder={() => { setFolderOpen(true); setEmptyContextMenu({ x: 0, y: 0, open: false }) }} onPasteFolder={() => { pasteFolder().catch((error) => setMessage(error instanceof Error ? error.message : 'Failed to paste folder')); setEmptyContextMenu({ x: 0, y: 0, open: false }) }} />
      <FileContextMenu x={contextMenu.x} y={contextMenu.y} file={contextMenu.file} onClose={() => setContextMenu({ x: 0, y: 0, file: null })} onView={viewFile} onDownload={() => { downloadFile().catch((error) => setMessage(error instanceof Error ? error.message : 'Download failed')) }} onRename={() => { setRenameValue(activeFile?.name ?? ''); setRenameOpen(true); setContextMenu({ x: 0, y: 0, file: null }) }} onMove={() => { setMoveOpen(true); setContextMenu({ x: 0, y: 0, file: null }) }} onDetails={() => { setDetailOpen(true); setContextMenu({ x: 0, y: 0, file: null }) }} onShare={shareFile} onCopyLink={copyShareLinkDirect} onInvite={inviteToFile} onDelete={() => { setDeleteOpen(true); setContextMenu({ x: 0, y: 0, file: null }) }} />
      <FolderContextMenu x={folderContextMenu.x} y={folderContextMenu.y} folder={folderContextMenu.folder} onClose={() => setFolderContextMenu({ x: 0, y: 0, folder: null })} onCut={() => cutSelectedFolder(activeFolderForMenu)} onRename={() => { setFolderRenameValue(activeFolderForMenu?.name ?? ''); setFolderRenameColor(normalizeFolderColor(activeFolderForMenu?.color)); setFolderRenameIconUrl(activeFolderForMenu?.iconUrl ?? defaultFolderIconUrl); setFolderRenameOpen(true); setFolderContextMenu({ x: 0, y: 0, folder: null }) }} onInvite={inviteToFolder} onCopyLink={copyFolderLink} onDelete={() => { setFolderDeleteOpen(true); setFolderContextMenu({ x: 0, y: 0, folder: null }) }}
        onDownloadZip={() => { downloadFolderZip(activeFolderForMenu).catch(() => undefined) }}
        onDownloadFolder={() => { downloadFolderPlain(activeFolderForMenu).catch(() => undefined) }}
        onLock={() => { if (activeFolderForMenu?.id) openLockDialog({ mode: 'set', folderId: activeFolderForMenu.id, folderName: activeFolderForMenu.name }) }}
        onChangeLock={() => { if (activeFolderForMenu?.id) openLockDialog({ mode: 'change', folderId: activeFolderForMenu.id, folderName: activeFolderForMenu.name }) }}
        onRemoveLock={() => { if (activeFolderForMenu?.id) openLockDialog({ mode: 'remove', folderId: activeFolderForMenu.id, folderName: activeFolderForMenu.name }) }} />
      <DummyModal open={Boolean(lockDialog)} title={lockText?.title ?? ''} description={lockDialog?.folderName ?? ''} onClose={closeLockDialog}>
        <form onSubmit={submitLockDialog} className="grid gap-4">
          {lockDialog?.mode === 'change' ? <label className="grid gap-2 text-sm font-semibold">Current folder password<Input type="password" value={lockCurrentPassword} onChange={(event) => setLockCurrentPassword(event.target.value)} autoComplete="off" autoFocus required /></label> : null}
          <label className="grid gap-2 text-sm font-semibold">{lockText?.label}<Input type="password" value={lockPassword} onChange={(event) => setLockPassword(event.target.value)} autoComplete={lockDialog?.mode === 'remove' ? 'current-password' : lockDialog?.mode === 'unlock' ? 'off' : 'new-password'} minLength={lockDialog?.mode === 'set' || lockDialog?.mode === 'change' ? 4 : undefined} autoFocus={lockDialog?.mode !== 'change'} required /></label>
          {lockDialog?.mode === 'set' || lockDialog?.mode === 'change' ? <label className="grid gap-2 text-sm font-semibold">Type it again<Input type="password" value={lockPasswordConfirm} onChange={(event) => setLockPasswordConfirm(event.target.value)} autoComplete="new-password" minLength={4} required /></label> : null}
          {lockDialog?.mode === 'set' ? <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">This folder, its subfolders and their files will open only with this password (at least 4 characters). If you forget it, you can remove the lock with your 9Drive account password. The lock is inside 9Drive: anyone who signs in to the storage account itself (e.g. Google Drive) can still see the files there.</p> : null}
          {lockDialog?.mode === 'remove' ? <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">Enter the password you use to log in to 9Drive. After this the folder opens without a password.</p> : null}
          {lockError ? <p className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{lockError}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {lockDialog?.mode === 'unlock' ? <button type="button" className="text-xs font-semibold text-blue-600 hover:underline" onClick={() => openLockDialog({ ...lockDialog, mode: 'remove' })}>Forgot the password? Remove the lock</button> : <span />}
            <div className="flex gap-3"><Button type="button" variant="outline" onClick={closeLockDialog}>Cancel</Button><Button disabled={lockBusy}>{lockBusy ? 'Please wait...' : lockText?.submit}</Button></div>
          </div>
        </form>
      </DummyModal>
      <FileDetailsDrawer open={detailOpen} file={activeFile} onClose={() => setDetailOpen(false)} />

      <DummyModal open={uploadOpen} title="Upload File" description="Stream file directly to selected Google Drive account." onClose={() => setUploadOpen(false)}>
        <form onSubmit={uploadFile} className="grid gap-4">
           <label onDragEnter={handleUploadDrag} onDragOver={handleUploadDrag} onDragLeave={handleUploadDrag} onDrop={handleUploadDrag} className={isUploadDragging ? 'grid cursor-pointer gap-3 rounded-2xl border-2 border-dashed border-blue-500 bg-blue-50 p-4 text-center transition sm:p-6' : 'grid cursor-pointer gap-3 rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 p-4 text-center transition hover:border-blue-300 hover:bg-blue-50/50 sm:p-6'}>
            <Upload className={isUploadDragging ? 'mx-auto h-8 w-8 text-blue-600' : 'mx-auto h-8 w-8 text-slate-500'} />
            <span className="text-sm font-extrabold text-slate-950">Drop file here or click to browse</span>
            <span className="text-xs text-slate-500">Metadata is sent before the file so upload can stream directly to Google Drive.</span>
            <Input type="file" className="sr-only" multiple onChange={(event) => selectUploadFiles(event.target.files)} required={selectedFiles.length === 0} />
          </label>
          <label className="grid gap-2 text-sm font-semibold">
            Target Storage Account
            <select
              className="h-11 rounded-xl border border-slate-200 px-3 text-sm bg-white"
              value={selectedTargetAccountId}
              onChange={(event) => setSelectedTargetAccountId(event.target.value)}
            >
              <option value="">Automatic (Default)</option>
              {connectedAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email || account.displayName || account.id} ({account.provider === 's3' ? 'S3' : 'Google Drive'})
                </option>
              ))}
            </select>
          </label>
          {activeFolder ? <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">Uploading to: <b>{activeFolder.name}</b></p> : <label className="grid gap-2 text-sm font-semibold">Virtual Folder<select className="h-11 rounded-xl border border-slate-200 px-3 text-sm bg-white" value={selectedFolderId} onChange={(event) => setSelectedFolderId(event.target.value)}><option value="">No folder</option>{allFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>}
          {selectedFiles.length > 0 ? <div className="grid max-h-56 gap-2 overflow-y-auto rounded-xl bg-slate-50 p-3 text-sm text-slate-600"><div className="flex items-center justify-between gap-3"><span className="font-bold text-slate-950">{selectedFiles.length} selected</span><span className="shrink-0">{formatBytes(selectedFiles.reduce((total, file) => total + file.size, 0))}</span></div>{selectedFiles.map((file, index) => <div key={`${file.name}-${file.size}-${index}`} className="flex min-w-0 items-center justify-between gap-3 rounded-lg bg-white px-3 py-2"><span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span><span className="shrink-0 text-xs text-slate-500">{formatBytes(file.size)}</span><button type="button" className="shrink-0 text-slate-500 hover:text-red-600" onClick={() => removeUploadFile(index)} aria-label={`Remove ${file.name}`}><X className="h-4 w-4" /></button></div>)}</div> : null}
          <div className="grid gap-3 sm:flex sm:justify-end"><Button type="button" variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button><Button disabled={loading || selectedFiles.length === 0}>{loading ? 'Uploading...' : `Upload${selectedFiles.length > 1 ? ` ${selectedFiles.length} files` : ''}`}</Button></div>
        </form>
      </DummyModal>
       <DummyModal open={folderOpen} title="New Folder" description="Create a virtual folder for organizing files." onClose={() => setFolderOpen(false)}>
        <form onSubmit={createFolder} className="grid gap-4">
          <label className="grid gap-2 text-sm font-semibold">Folder Name<Input value={folderName} onChange={(event) => setFolderName(event.target.value)} placeholder="Project Assets" required /></label>
          <FolderAppearanceFields color={folderColor} iconUrl={folderIconUrl} onColorChange={setFolderColor} onIconChange={setFolderIconUrl} />
          <div className="grid gap-3 pt-2 sm:flex sm:justify-end"><Button type="button" variant="outline" onClick={() => setFolderOpen(false)}>Cancel</Button><Button>Create Folder</Button></div>
        </form>
      </DummyModal>
      <DummyModal open={renameOpen} title="Rename File" description={activeFile?.name ?? ''} onClose={() => setRenameOpen(false)}><form onSubmit={renameFile} className="grid gap-4"><Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} required /><div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={() => setRenameOpen(false)}>Cancel</Button><Button>Rename</Button></div></form></DummyModal>
      <DummyModal open={moveOpen} title="Move to Folder" description={selectedFileIds.size > 0 ? `Move ${selectedFileIds.size} files` : activeFile?.name ?? ''} onClose={() => setMoveOpen(false)}><form onSubmit={moveFile} className="grid gap-4"><select className="h-11 rounded-xl border border-slate-200 px-3 text-sm" value={selectedFolderId} onChange={(event) => setSelectedFolderId(event.target.value)}><option value="">No folder</option>{allFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={() => setMoveOpen(false)}>Cancel</Button><Button>Move</Button></div></form></DummyModal>
      <DummyModal open={Boolean(duplicatePrompt)} title="Files with the same name already exist" description={duplicatePrompt ? `${duplicatePrompt.duplicates.length} of ${duplicatePrompt.files.length} selected file${duplicatePrompt.files.length === 1 ? '' : 's'} already ${duplicatePrompt.duplicates.length === 1 ? 'exists' : 'exist'}. Do you still want to upload ${duplicatePrompt.duplicates.length === 1 ? 'it' : 'them'}?` : ''} onClose={() => answerDuplicatePrompt('cancel')}>
        <div className="grid gap-4">
          <ul className="grid max-h-56 gap-1.5 overflow-y-auto rounded-xl bg-slate-50 p-3 text-sm">
            {duplicatePrompt?.duplicates.map((duplicate, index) => (
              <li key={`${duplicate.name}-${index}`} className="flex min-w-0 items-center justify-between gap-3">
                <span className="min-w-0 truncate font-semibold" title={duplicate.name}>{duplicate.name}</span>
                <span className="shrink-0 text-xs text-slate-500">{duplicate.location}</span>
              </li>
            ))}
          </ul>
          <div className="grid gap-2 sm:flex sm:justify-end">
            <Button variant="outline" onClick={() => answerDuplicatePrompt('cancel')}>Cancel</Button>
            {duplicatePrompt && duplicatePrompt.duplicates.length < duplicatePrompt.files.length ? <Button variant="outline" onClick={() => answerDuplicatePrompt('skip')}>Skip duplicates</Button> : null}
            <Button onClick={() => answerDuplicatePrompt('all')}>Upload anyway</Button>
          </div>
        </div>
      </DummyModal>
      <DummyModal open={deleteOpen} title={selectedFileIds.size > 0 ? 'Delete Files' : 'Delete File'} description={selectedFileIds.size > 0 ? `Delete ${selectedFileIds.size} files from Google Drive?` : `Delete ${activeFile?.name ?? 'file'} from Google Drive?`} onClose={() => setDeleteOpen(false)}><div className="flex justify-end gap-3"><Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button><Button variant="danger" onClick={deleteFile}>Delete</Button></div></DummyModal>
      <DummyModal open={folderRenameOpen} title="Rename Folder" description={activeFolderForMenu?.name ?? ''} onClose={() => setFolderRenameOpen(false)}><form onSubmit={renameFolder} className="grid gap-4"><Input value={folderRenameValue} onChange={(event) => setFolderRenameValue(event.target.value)} required /><FolderAppearanceFields color={folderRenameColor} iconUrl={folderRenameIconUrl} onColorChange={setFolderRenameColor} onIconChange={setFolderRenameIconUrl} /><div className="flex justify-end gap-3"><Button type="button" variant="outline" onClick={() => setFolderRenameOpen(false)}>Cancel</Button><Button>Rename</Button></div></form></DummyModal>
      <DummyModal open={folderDeleteOpen} title="Delete Folder" description={`Delete virtual folder ${activeFolderForMenu?.name ?? ''}? Files inside will move to the Recycle Bin.`} onClose={() => setFolderDeleteOpen(false)}><div className="flex justify-end gap-3"><Button variant="outline" onClick={() => setFolderDeleteOpen(false)}>Cancel</Button><Button variant="danger" onClick={deleteFolder}>Delete</Button></div></DummyModal>
      <DummyModal open={inviteOpen} title="Invite Member" description={`Share ${inviteTargetType === 'file' ? (activeFile?.name ?? 'file') : (activeFolderForMenu?.name ?? 'folder')} with a team member.`} onClose={() => setInviteOpen(false)}>
        <form onSubmit={sendInvite} className="grid gap-4">
          <label className="grid gap-2 text-sm font-semibold">Email Address<Input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="member@example.com" required /></label>
          <label className="grid gap-2 text-sm font-semibold">Role<select className="h-11 rounded-xl border border-slate-200 px-3 text-sm" value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}><option value="viewer">Can view</option><option value="editor">Can edit</option></select></label>
          {inviteMessage ? <p className="rounded-xl bg-blue-50 p-3 text-sm font-semibold text-blue-700">{inviteMessage}</p> : null}
          <div className="flex justify-end gap-3 pt-2"><Button type="button" variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button><Button disabled={inviting}>{inviting ? 'Sending...' : 'Send Invite'}</Button></div>
        </form>
      </DummyModal>
      <MediaViewer
        open={previewOpen}
        name={activeFile?.name ?? ''}
        kind={activePreviewKind}
        url={previewUrl}
        loading={previewLoading}
        error={previewError}
        onClose={closePreview}
        onDownload={() => { downloadFile().catch((error) => setPreviewError(error instanceof Error ? error.message : 'Download failed')) }}
        officeOpenUrl={activePreviewKind === 'office' && previewUrl ? previewUrl.replace('/preview', '/view') : undefined}
      />
    </>
  )
}
