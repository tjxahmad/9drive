export type PreviewKind = 'image' | 'video' | 'document' | 'office'

const officeMimeTypes = new Set([
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

const googleDocumentMimeTypes = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
])

export function getPreviewKind(mimeType: string | undefined): PreviewKind | null {
  if (!mimeType) return null
  if (mimeType.startsWith('image/') || mimeType === 'application/vnd.google-apps.drawing') return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType === 'application/pdf' || googleDocumentMimeTypes.has(mimeType)) return 'document'
  if (officeMimeTypes.has(mimeType)) return 'office'
  return null
}

// Google Drive's built-in viewer for Office files. It only opens for the Google account that owns the file.
export function drivePreviewUrl(webViewLink: string, accountEmail?: string) {
  const url = new URL(webViewLink.replace(/\/view(\?.*)?$/, '/preview'))
  url.search = ''
  if (accountEmail) url.searchParams.set('authuser', accountEmail)
  return url.toString()
}

export function isSpreadsheetMimeType(mimeType: string | undefined) {
  return mimeType === 'application/vnd.google-apps.spreadsheet' || mimeType === 'application/vnd.ms-excel' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}
