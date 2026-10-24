declare global {
  interface Window {
    Plyr?: new (element: HTMLVideoElement, options?: Record<string, unknown>) => { destroy: () => void }
    __plyrReady?: Promise<void>
  }
}

export function ensurePlyr() {
  if (window.Plyr) return Promise.resolve()
  if (window.__plyrReady) return window.__plyrReady

  window.__plyrReady = new Promise<void>((resolve, reject) => {
    if (!document.querySelector('link[data-plyr="true"]')) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = 'https://cdnjs.cloudflare.com/ajax/libs/plyr/3.7.8/plyr.css'
      // Subresource Integrity: the browser refuses the file if the CDN copy was tampered with.
      link.integrity = 'sha512-yexU9hwne3MaLL2PG+YJDhaySS9NWcj6z7MvUDSoMhwNghPgXgcvYgVhfj4FMYpPh1Of7bt8/RK5A0rQ9fPMOw=='
      link.crossOrigin = 'anonymous'
      link.referrerPolicy = 'no-referrer'
      link.dataset.plyr = 'true'
      document.head.appendChild(link)
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-plyr="true"]')
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Failed to load Plyr')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/plyr/3.7.8/plyr.min.js'
    script.integrity = 'sha512-vONptKEoKbP1gaC5UkbYDa9OPr04ur4bxaaqT7DAJxGHB2oogtseCPrl5e5hPFokGYotlGNV4d+GM593ka7iNA=='
    script.crossOrigin = 'anonymous'
    script.referrerPolicy = 'no-referrer'
    script.async = true
    script.dataset.plyr = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Plyr'))
    document.body.appendChild(script)
  })

  return window.__plyrReady
}

export function createPlyr(element: HTMLVideoElement) {
  if (!window.Plyr) return null
  return new window.Plyr(element, {
    controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen'],
    // iPhone: use the native full-screen player (rotates with the phone); elsewhere the Fullscreen API.
    fullscreen: { enabled: true, fallback: true, iosNative: true },
  })
}

export {}
