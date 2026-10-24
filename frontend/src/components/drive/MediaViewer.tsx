import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, Maximize2, Minimize2, X } from 'lucide-react'
import { createPlyr, ensurePlyr } from '@/lib/plyr'
import type { PreviewKind } from '@/lib/preview'

type ScreenOrientationWithLock = ScreenOrientation & { lock?: (orientation: 'landscape') => Promise<void> }

function ViewerButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
      {children}
    </button>
  )
}

// Full-screen viewer for photos, videos and documents (phone and desktop). Videos can go full screen and turn to
// landscape like YouTube; on iPhone the native video player is used, which rotates by itself.
export function MediaViewer({ open, name, kind, url, loading, error, onClose, onDownload, officeOpenUrl }: {
  open: boolean
  name: string
  kind: PreviewKind | null
  url: string
  loading: boolean
  error: string
  onClose: () => void
  onDownload?: () => void
  officeOpenUrl?: string
}) {
  const shellRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const canFullscreen = typeof document !== 'undefined' && Boolean(document.fullscreenEnabled)

  // Lock page scroll; Escape closes (the first Escape only leaves full screen).
  useEffect(() => {
    if (!open) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.fullscreenElement) onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  // Track full screen; turn landscape videos sideways while full screen (supported on Android Chrome).
  useEffect(() => {
    if (!open) return undefined
    const orientation = (typeof screen !== 'undefined' ? screen.orientation : undefined) as ScreenOrientationWithLock | undefined
    const onChange = () => {
      const active = Boolean(document.fullscreenElement)
      setIsFullscreen(active)
      const video = videoRef.current
      if (active && video && video.videoWidth > video.videoHeight) orientation?.lock?.('landscape').catch(() => undefined)
      if (!active) orientation?.unlock?.()
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined)
      orientation?.unlock?.()
    }
  }, [open])

  // Nicer video controls (Plyr); the browser's own controls stay as a fallback if it can't load.
  useEffect(() => {
    if (!open || kind !== 'video' || !url || !videoRef.current) return undefined
    let disposed = false
    let player: { destroy: () => void } | null = null
    ensurePlyr().then(() => {
      if (disposed || !videoRef.current) return
      player = createPlyr(videoRef.current)
    }).catch(() => undefined)
    return () => {
      disposed = true
      player?.destroy()
    }
  }, [open, kind, url])

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined)
    else shellRef.current?.requestFullscreen().catch(() => undefined)
  }

  if (!open) return null

  return (
    <div ref={shellRef} role="dialog" aria-modal="true" aria-label={`Preview: ${name}`} className="media-viewer fixed inset-0 z-[80] flex flex-col bg-black">
      <div className="flex items-center gap-2 bg-gradient-to-b from-black/90 to-black/40 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-4">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold sm:text-base" title={name}>{name}</p>
        {onDownload ? <ViewerButton label="Download" onClick={onDownload}><Download className="h-5 w-5" /></ViewerButton> : null}
        {canFullscreen ? <ViewerButton label={isFullscreen ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen}>{isFullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}</ViewerButton> : null}
        <ViewerButton label="Close" onClick={onClose}><X className="h-5 w-5" /></ViewerButton>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center pb-[env(safe-area-inset-bottom)] sm:p-3">
        {loading ? <p className="text-sm font-semibold">Loading preview...</p> : null}
        {!loading && error ? <p className="max-w-md px-6 text-center text-sm text-red-300">{error}</p> : null}
        {!loading && !error && url && kind === 'image' ? <img src={url} alt={name} draggable={false} className="max-h-full max-w-full select-none object-contain" /> : null}
        {!loading && !error && url && kind === 'video' ? (
          <div className="media-viewer-video h-full w-full">
            {/* No `type` attribute: browsers then try the file instead of skipping types like video/quicktime (.mov). */}
            <video ref={videoRef} src={url} controls playsInline preload="metadata" className="h-full w-full" />
          </div>
        ) : null}
        {!loading && !error && url && kind === 'document' ? <iframe src={url} title={name} className="h-full w-full border-0 bg-white sm:rounded-xl" /> : null}
        {!loading && !error && url && kind === 'office' ? (
          <div className="flex h-full w-full flex-col">
            <iframe src={url} title={name} className="w-full flex-1 border-0 bg-white sm:rounded-xl" />
            {officeOpenUrl ? <a href={officeOpenUrl} target="_blank" rel="noopener noreferrer" className="p-2 text-center text-xs font-semibold text-blue-300 hover:underline">Preview blank? Open in Google Drive</a> : null}
          </div>
        ) : null}
        {!loading && !error && !kind ? <p className="max-w-md px-6 text-center text-sm">Preview is not available for this file type. Use Download instead.</p> : null}
      </div>
    </div>
  )
}
