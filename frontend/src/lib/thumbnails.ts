import { API_URL, refreshAccessToken } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'

// Thumbnails are fetched with the login token (an <img> tag can't send it), kept as object URLs for the session,
// and loaded at most a few at a time so a big folder doesn't flood the connection.
const MAX_PARALLEL = 4
const RETRY_FAILED_AFTER_MS = 60_000

const cache = new Map<string, Promise<string | null>>()
const waiting: Array<() => void> = []
let running = 0

async function withSlot<T>(task: () => Promise<T>) {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve))
  running += 1
  try {
    return await task()
  } finally {
    running -= 1
    waiting.shift()?.()
  }
}

async function fetchThumbnail(fileId: string) {
  const request = () => fetch(`${API_URL}/files/${fileId}/thumbnail`, { headers: { Authorization: `Bearer ${getAccessToken()}` } })
  let response = await request()
  if (response.status === 401 && await refreshAccessToken()) response = await request()
  if (!response.ok) return null
  return URL.createObjectURL(await response.blob())
}

export function loadThumbnail(fileId: string) {
  let pending = cache.get(fileId)
  if (!pending) {
    pending = withSlot(() => fetchThumbnail(fileId)).catch(() => null)
    cache.set(fileId, pending)
    // A missing thumbnail (e.g. Google still processing a new upload) is retried later.
    pending.then((url) => { if (!url) setTimeout(() => cache.delete(fileId), RETRY_FAILED_AFTER_MS) })
  }
  return pending
}
