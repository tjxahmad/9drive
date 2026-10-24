import type { ConnectedAccount, File } from '@prisma/client'
import type { Response } from 'express'
import { streamGoogleFile } from './stream-google-file.js'
import { streamS3File } from '../s3/s3.service.js'

type FileWithAccount = File & { connectedAccount: ConnectedAccount }
type StreamOptions = { disposition?: 'inline' | 'attachment' }

// Uploaded HTML/SVG/XML could run scripts when opened inline; serve it sandboxed.
const scriptableMimeTypes = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml'])

export function streamProviderFile(file: FileWithAccount, range: string | undefined, res: Response, options: StreamOptions = {}) {
  if (scriptableMimeTypes.has(file.mimeType.toLowerCase())) res.setHeader('Content-Security-Policy', 'sandbox')
  if (file.provider === 's3') return streamS3File(file, range, res, options)
  return streamGoogleFile(file, range, res, options)
}
