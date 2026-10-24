import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { API_URL, apiFetch, refreshAccessToken } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'

export type UploadProgressStatus = 'uploading' | 'waiting' | 'done' | 'error' | 'partial'
export type UploadProgressFile = { name: string; size: number; percent: number; status: UploadProgressStatus }
export type UploadProgressState = { open: boolean; fileName: string; percent: number; status: UploadProgressStatus; files: UploadProgressFile[] }

type ResumableSession = { file: File; folderId?: string | null; targetAccountId?: string | null }

type UploadContextType = {
  uploadProgress: UploadProgressState
  setUploadProgress: React.Dispatch<React.SetStateAction<UploadProgressState>>
  uploadFiles: (files: File[], folderId: string | null, targetAccountId?: string | null) => Promise<void>
  retryFailedUpload: (fileName: string) => Promise<void>
  unfinishedUploads: string[]
  dismissUnfinishedUploads: () => void
}

const UploadContext = createContext<UploadContextType | undefined>(undefined)

const CHUNK_SIZE = 5 * 1024 * 1024 // 5MB chunks (multiple of 256KB for Google Drive; must equal S3_PART_SIZE in the backend for S3/R2)

// Unfinished uploads are remembered in this browser, so selecting the same file again (after a refresh,
// closing the app or losing the network) continues from where it stopped instead of starting over.
const PENDING_UPLOADS_KEY = '9drive.pendingUploads'
const PENDING_UPLOAD_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000 // Google keeps an upload session for about a week
type PendingUpload = { sessionId: string; fileName: string; createdAt: number }

function readPendingUploads(): Record<string, PendingUpload> {
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_UPLOADS_KEY) ?? '{}') as Record<string, PendingUpload>
    return Object.fromEntries(Object.entries(all).filter(([, upload]) => Date.now() - upload.createdAt < PENDING_UPLOAD_MAX_AGE_MS))
  } catch {
    return {}
  }
}

function writePendingUpload(key: string, upload: PendingUpload | null) {
  try {
    const all = readPendingUploads()
    if (upload) all[key] = upload
    else delete all[key]
    localStorage.setItem(PENDING_UPLOADS_KEY, JSON.stringify(all))
  } catch {
    // Storage unavailable: uploads still work, they just can't resume after a refresh.
  }
}

function pendingUploadKey(file: File, folderId: string | null) {
  return `${file.name}|${file.size}|${file.lastModified}|${folderId ?? ''}`
}

class FatalUploadError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForNetwork(delayMs: number) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    await new Promise<void>((resolve) => window.addEventListener('online', () => resolve(), { once: true }))
  }
  await sleep(delayMs)
}

async function putChunk(sessionId: string, chunk: Blob, start: number, end: number, total: number) {
  const send = () => fetch(`${API_URL}/uploads/resumable/chunk/${sessionId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${getAccessToken()}`,
      'Content-Range': `bytes ${start}-${end - 1}/${total}`,
      'Content-Length': String(chunk.size)
    },
    body: chunk
  })
  let response = await send()
  // Long uploads outlive the 15-minute access token: refresh it and resend.
  if (response.status === 401 && await refreshAccessToken()) response = await send()
  if (response.ok) return await response.json() as { status: string; offset?: string }
  if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
    const error = await response.json().catch(() => ({ message: response.statusText })) as { message?: string }
    throw new FatalUploadError(error.message || 'Chunk upload failed')
  }
  throw new Error(`Server error ${response.status}`)
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState>({
    open: false,
    fileName: '',
    percent: 0,
    status: 'uploading',
    files: []
  })
  const [resumableSessions, setResumableSessions] = useState<Record<string, ResumableSession>>({})
  const [unfinishedUploads, setUnfinishedUploads] = useState<string[]>(() => [...new Set(Object.values(readPendingUploads()).map((upload) => upload.fileName))])
  // A new batch started while another is still uploading is appended to the panel instead of replacing it.
  const activeBatchesRef = useRef(0)
  const panelFileCountRef = useRef(0)

  function setFileState(index: number, update: Partial<UploadProgressFile>) {
    setUploadProgress((current) => {
      const nextFiles = [...current.files]
      if (nextFiles[index]) nextFiles[index] = { ...nextFiles[index], ...update }
      const overallPercent = nextFiles.length ? Math.round(nextFiles.reduce((sum, f) => sum + f.percent, 0) / nextFiles.length) : 0
      return { ...current, percent: overallPercent, files: nextFiles }
    })
  }

  async function uploadSingleFileResumable(file: File, folderId: string | null, onProgress: (percent: number) => void, onWaiting: (waiting: boolean) => void, targetAccountId?: string | null) {
    setResumableSessions(prev => ({ ...prev, [file.name]: { file, folderId, targetAccountId } }))
    const key = pendingUploadKey(file, folderId)
    const percentOf = (offset: number) => Math.min(99, Math.round((offset / file.size) * 100))

    // 1. Resume a remembered session for this exact file, or start a new one.
    let sessionId = readPendingUploads()[key]?.sessionId ?? ''
    let startOffset = 0
    if (sessionId) {
      const statusData = await apiFetch<{ status: string; offset: string }>(`/uploads/resumable/status/${sessionId}`).catch(() => null)
      if (statusData?.status === 'completed') {
        writePendingUpload(key, null)
        onProgress(100)
        return
      }
      if (statusData?.status === 'uploading') startOffset = Number(statusData.offset)
      else sessionId = ''
    }
    if (!sessionId) {
      const initData = await apiFetch<{ sessionId: string; provider: string }>('/uploads/resumable/init', {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: String(file.size),
          folderId: folderId || undefined,
          targetAccountId: targetAccountId || undefined
        })
      })
      sessionId = initData.sessionId
      writePendingUpload(key, { sessionId, fileName: file.name, createdAt: Date.now() })
    }
    onProgress(percentOf(startOffset))

    // 2. Upload chunk by chunk. Network/server errors wait and continue from the offset the server has.
    let failures = 0
    while (startOffset < file.size) {
      const endOffset = Math.min(startOffset + CHUNK_SIZE, file.size)
      try {
        const resData = await putChunk(sessionId, file.slice(startOffset, endOffset), startOffset, endOffset, file.size)
        failures = 0
        onWaiting(false)
        if (resData.status === 'completed') break
        startOffset = Number(resData.offset)
        onProgress(percentOf(startOffset))
      } catch (error) {
        if (error instanceof FatalUploadError) throw error
        failures += 1
        if (failures > 60) throw new Error('Upload paused too long without a connection. Select the file again to continue.')
        onWaiting(true)
        await waitForNetwork(Math.min(30_000, 2_000 * failures))
        const statusData = await apiFetch<{ status: string; offset: string }>(`/uploads/resumable/status/${sessionId}`).catch(() => null)
        if (statusData?.status === 'completed') break
        if (statusData?.status === 'uploading') startOffset = Number(statusData.offset)
      }
    }
    writePendingUpload(key, null)
    setUnfinishedUploads((names) => names.filter((name) => name !== file.name))
    onProgress(100)
  }

  async function uploadFiles(filesToUpload: File[], targetFolderId: string | null, targetAccountId?: string | null) {
    if (filesToUpload.length === 0) return

    const newEntries: UploadProgressFile[] = filesToUpload.map(f => ({ name: f.name, size: f.size, percent: 0, status: 'uploading' }))
    const appending = activeBatchesRef.current > 0
    const offset = appending ? panelFileCountRef.current : 0
    panelFileCountRef.current = offset + newEntries.length
    activeBatchesRef.current += 1
    setUploadProgress((current) => appending
      ? { ...current, open: true, status: 'uploading', fileName: `${current.files.length + newEntries.length} files`, files: [...current.files, ...newEntries] }
      : { open: true, fileName: filesToUpload.length === 1 ? filesToUpload[0].name : `${filesToUpload.length} files`, percent: 0, status: 'uploading', files: newEntries })

    // Upload files sequentially
    try {
      for (let i = 0; i < filesToUpload.length; i++) {
        const file = filesToUpload[i]
        const index = offset + i
        try {
          await uploadSingleFileResumable(
            file,
            targetFolderId,
            (filePercent) => setFileState(index, { percent: filePercent, status: filePercent >= 100 ? 'done' : 'uploading' }),
            (waiting) => setFileState(index, { status: waiting ? 'waiting' : 'uploading' }),
            targetAccountId,
          )
        } catch (err) {
          console.error('File upload failed:', file.name, err)
          setFileState(index, { status: 'error' })
        }
      }
    } finally {
      activeBatchesRef.current -= 1
    }
    if (activeBatchesRef.current === 0) {
      setUploadProgress((current) => ({ ...current, status: current.files.some((f) => f.status === 'error') ? 'partial' : 'done' }))
    }

    // Dispatch global events so active pages reload their data
    window.dispatchEvent(new Event('9drive:storage-changed'))
    window.dispatchEvent(new Event('9drive:upload-completed'))
  }

  async function retryFailedUpload(fileName: string) {
    const session = resumableSessions[fileName]
    if (!session) return
    const fileIndex = uploadProgress.files.findIndex(f => f.name === fileName)

    setUploadProgress((current) => ({ ...current, status: 'uploading' }))
    setFileState(fileIndex, { status: 'uploading' })

    try {
      await uploadSingleFileResumable(
        session.file,
        session.folderId || null,
        (filePercent) => setFileState(fileIndex, { percent: filePercent, status: filePercent >= 100 ? 'done' : 'uploading' }),
        (waiting) => setFileState(fileIndex, { status: waiting ? 'waiting' : 'uploading' }),
        session.targetAccountId,
      )
      setUploadProgress((current) => ({ ...current, status: current.files.every(f => f.status === 'done') ? 'done' : 'partial' }))
      window.dispatchEvent(new Event('9drive:storage-changed'))
      window.dispatchEvent(new Event('9drive:upload-completed'))
    } catch (err) {
      console.error('Retry upload failed:', fileName, err)
      setFileState(fileIndex, { status: 'error' })
      setUploadProgress((current) => ({ ...current, status: 'partial' }))
    }
  }

  function dismissUnfinishedUploads() {
    setUnfinishedUploads([])
  }

  return (
    <UploadContext.Provider value={{ uploadProgress, setUploadProgress, uploadFiles, retryFailedUpload, unfinishedUploads, dismissUnfinishedUploads }}>
      {children}
    </UploadContext.Provider>
  )
}

export function useUpload() {
  const context = useContext(UploadContext)
  if (context === undefined) {
    throw new Error('useUpload must be used within an UploadProvider')
  }
  return context
}
