import { API_URL, apiFetch, refreshAccessToken } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'
import { folderUnlockHeader } from '@/lib/folderLocks'

// Downloads go through short-lived links that the browser downloads by itself: the file streams straight to disk
// and the browser shows its own progress (works for multi-GB videos, in the desktop app window and on phones).
export function startBrowserDownload(path: string) {
  const link = document.createElement('a')
  link.href = `${API_URL}${path}`
  link.download = ''
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export async function downloadFile(fileId: string) {
  const { path } = await apiFetch<{ path: string }>(`/files/${fileId}/download-link`, { method: 'POST' })
  startBrowserDownload(path)
}

export async function downloadFilesAsZip(fileIds: string[]) {
  const { path } = await apiFetch<{ path: string }>('/files/zip-link', { method: 'POST', body: JSON.stringify({ fileIds }) })
  startBrowserDownload(path)
}

export async function downloadFolderAsZip(folderId: string) {
  const data = await apiFetch<{ path: string; count: number; lockedSubfolders: number }>(`/folders/${folderId}/zip-link`, { method: 'POST' })
  startBrowserDownload(data.path)
  return data
}

type FolderListing = { name: string; lockedSubfolders: number; files: Array<{ id: string; name: string; path: string; sizeBytes: string }> }
export type FolderSaveProgress = { doneFiles: number; totalFiles: number; doneBytes: number; totalBytes: number }
type DirectoryHandle = FileSystemDirectoryHandle
type DirectoryPicker = (options?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<DirectoryHandle>

function directoryPicker() {
  return (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker
}

// Desktop Chrome/Edge (and the 9Drive app window) can write a real folder; phones get one download per file.
export function canSaveFolderDirectly() {
  return typeof directoryPicker() === 'function'
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Saves a folder, with its subfolders, as a normal folder in a place the user picks (no ZIP). Each file streams
// to disk; nothing big is kept in memory. Returns null if the user closed the folder picker.
export async function saveFolderToDisk(folderId: string, onProgress: (progress: FolderSaveProgress) => void, signal?: AbortSignal) {
  const picker = directoryPicker()
  // Ask for the place first: the browser only shows its picker right after a click.
  let parent: DirectoryHandle | null = null
  if (picker) {
    try {
      parent = await picker({ mode: 'readwrite', id: '9drive-folder-download' })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null
      throw error
    }
  }
  const listing = await apiFetch<FolderListing>(`/folders/${folderId}/download-list`)
  const totalBytes = listing.files.reduce((total, file) => total + Number(file.sizeBytes), 0)
  const progress: FolderSaveProgress = { doneFiles: 0, totalFiles: listing.files.length, doneBytes: 0, totalBytes }
  onProgress({ ...progress })

  if (!parent) {
    for (const file of listing.files) {
      signal?.throwIfAborted()
      await downloadFile(file.id)
      progress.doneFiles += 1
      progress.doneBytes += Number(file.sizeBytes)
      onProgress({ ...progress })
      await wait(800)
    }
    return listing
  }

  // The unlocks from the start: leaving the folder (which locks it in the app) must not break a running save.
  const unlockHeader = folderUnlockHeader()
  const request = (fileId: string) => fetch(`${API_URL}/files/${fileId}/download`, {
    headers: { Authorization: `Bearer ${getAccessToken()}`, ...(unlockHeader ? { 'X-Folder-Unlock': unlockHeader } : {}) },
    signal,
  })
  for (const file of listing.files) {
    signal?.throwIfAborted()
    const segments = file.path.split('/')
    let directory = parent
    for (const segment of segments.slice(0, -1)) directory = await directory.getDirectoryHandle(segment, { create: true })
    let response = await request(file.id)
    if (response.status === 401 && await refreshAccessToken()) response = await request(file.id)
    if (!response.ok || !response.body) throw new Error(`Could not download ${file.name}.`)
    const handle = await directory.getFileHandle(segments[segments.length - 1], { create: true })
    const writable = await handle.createWritable()
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        progress.doneBytes += chunk.byteLength
        onProgress({ ...progress })
        controller.enqueue(chunk)
      },
    })
    await response.body.pipeThrough(counter).pipeTo(writable, { signal })
    progress.doneFiles += 1
    onProgress({ ...progress })
  }
  return listing
}
