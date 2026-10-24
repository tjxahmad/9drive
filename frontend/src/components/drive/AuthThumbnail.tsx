import { useEffect, useRef, useState, type ReactNode } from 'react'
import { loadThumbnail } from '@/lib/thumbnails'
import { cn } from '@/lib/utils'

// Shows a file's thumbnail once it scrolls near the screen; shows `fallback` until then or if there is none.
export function AuthThumbnail({ fileId, alt = '', className, fallback }: { fileId?: string; alt?: string; className?: string; fallback?: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element || visible) return undefined
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return undefined
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '200px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible || !fileId) return undefined
    let active = true
    loadThumbnail(fileId).then((thumbnailUrl) => { if (active) setUrl(thumbnailUrl) })
    return () => { active = false }
  }, [visible, fileId])

  return (
    <div ref={ref} className={cn('relative overflow-hidden', className)}>
      {url ? <img src={url} alt={alt} decoding="async" draggable={false} className="h-full w-full object-cover" /> : fallback}
    </div>
  )
}
