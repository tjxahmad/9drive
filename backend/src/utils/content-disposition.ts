// Content-Disposition header for a file name. Names with non-English letters (e.g. Urdu) are sent as UTF-8
// (RFC 5987) with a plain-ASCII fallback; putting them in the header as-is makes Node throw.
export function contentDisposition(type: 'inline' | 'attachment', fileName: string) {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '') || 'download'
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}
