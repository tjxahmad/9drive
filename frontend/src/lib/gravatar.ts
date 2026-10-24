// Builds a local avatar (initial letter on a colored circle) from the user's email.
// Generated in the browser so the email (or its hash) is never sent to Gravatar or any other third party.
export async function getGravatarUrl(email: string | undefined, size: number) {
  const normalized = email?.trim().toLowerCase() ?? ''
  const initial = (normalized.match(/[a-z0-9]/)?.[0] ?? 'u').toUpperCase()
  const colors = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#db2777', '#0891b2']
  const color = colors[simpleHash(normalized) % colors.length]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="${color}"/><text x="32" y="41" font-family="sans-serif" font-size="28" font-weight="700" fill="#ffffff" text-anchor="middle">${initial}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function simpleHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0 // Convert to 32bit integer
  }
  return Math.abs(hash)
}
