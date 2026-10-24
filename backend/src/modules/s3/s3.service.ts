import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, ListPartsCommand, S3Client, UploadPartCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { ConnectedAccount, File, S3StorageConfig } from '@prisma/client'
import type { Response } from 'express'
import type { Readable } from 'node:stream'
import { prisma } from '../../config/prisma.js'
import { decryptText } from '../../utils/crypto.js'

type S3Config = S3StorageConfig
type FileWithAccount = File & { connectedAccount: ConnectedAccount }
type StreamOptions = { disposition?: 'inline' | 'attachment' }

function contentDisposition(type: 'inline' | 'attachment', fileName: string) {
  return `${type}; filename="${fileName.replaceAll('"', '')}"`
}

export function createS3Client(config: S3Config) {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint ?? undefined,
    forcePathStyle: config.forcePathStyle || Boolean(config.endpoint),
    credentials: {
      accessKeyId: decryptText(config.accessKeyIdEncrypted),
      secretAccessKey: decryptText(config.secretAccessKeyEncrypted),
    },
  })
}

// Cloudflare R2's free tier includes 10 GB of storage per month. Every R2 bucket is capped below that
// (9 GB, counting everything in the bucket) so usage never becomes billable, whatever quota was entered.
export const R2_FREE_TIER_SAFE_BYTES = 9_000_000_000n

export function isCloudflareR2(endpoint: string | null | undefined) {
  if (!endpoint) return false
  try {
    return new URL(endpoint).hostname.toLowerCase().endsWith('.r2.cloudflarestorage.com')
  } catch {
    return false
  }
}

export function effectiveQuotaBytes(config: Pick<S3Config, 'endpoint' | 'quotaBytes'>) {
  if (!isCloudflareR2(config.endpoint)) return config.quotaBytes
  return config.quotaBytes === null || config.quotaBytes > R2_FREE_TIER_SAFE_BYTES ? R2_FREE_TIER_SAFE_BYTES : config.quotaBytes
}

export async function getS3ConfigForAccount(accountId: string, userId?: string) {
  return prisma.s3StorageConfig.findFirstOrThrow({ where: { connectedAccountId: accountId, status: 'active', ...(userId ? { userId } : {}) } })
}

export async function testS3Connection(config: S3Config) {
  const client = createS3Client(config)
  await client.send(new HeadBucketCommand({ Bucket: config.bucket }))
}

function safeFileName(name: string) {
  return name.replace(/[\\/]+/g, '-').replace(/[\u0000-\u001f\u007f]+/g, '').slice(0, 180) || 'file'
}

export function buildS3ObjectKey(config: Pick<S3Config, 'prefix'>, userId: string, fileId: string, fileName: string) {
  return `${config.prefix.replace(/^\/+|\/+$/g, '')}/${userId}/${fileId}/${safeFileName(fileName)}`
}

export async function uploadS3Object(config: S3Config, key: string, body: NodeJS.ReadableStream, mimeType: string) {
  const client = createS3Client(config)
  await new Upload({
    client,
    params: { Bucket: config.bucket, Key: key, Body: body as Readable, ContentType: mimeType },
  }).done()
}

// Chunked uploads from the browser use S3 multipart uploads. Must match the frontend chunk size;
// S3/R2 need every part except the last to be at least 5 MiB (R2 also needs them equal).
export const S3_PART_SIZE = 5 * 1024 * 1024

export async function createS3MultipartUpload(config: S3Config, key: string, mimeType: string) {
  const client = createS3Client(config)
  const response = await client.send(new CreateMultipartUploadCommand({ Bucket: config.bucket, Key: key, ContentType: mimeType }))
  if (!response.UploadId) throw new Error('Storage did not return a multipart upload id.')
  return response.UploadId
}

export async function uploadS3Part(config: S3Config, key: string, uploadId: string, partNumber: number, body: Buffer) {
  const client = createS3Client(config)
  await client.send(new UploadPartCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body, ContentLength: body.length }))
}

export async function listS3UploadedParts(config: S3Config, key: string, uploadId: string) {
  const client = createS3Client(config)
  const parts: Array<{ partNumber: number; etag: string; size: number }> = []
  let marker: string | undefined
  do {
    const response = await client.send(new ListPartsCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }))
    for (const part of response.Parts ?? []) {
      if (part.PartNumber && part.ETag) parts.push({ partNumber: part.PartNumber, etag: part.ETag, size: part.Size ?? 0 })
    }
    marker = response.IsTruncated ? response.NextPartNumberMarker : undefined
  } while (marker)
  return parts.sort((a, b) => a.partNumber - b.partNumber)
}

export async function completeS3MultipartUpload(config: S3Config, key: string, uploadId: string) {
  const parts = await listS3UploadedParts(config, key, uploadId)
  const client = createS3Client(config)
  await client.send(new CompleteMultipartUploadCommand({
    Bucket: config.bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
  }))
  return parts.reduce((sum, part) => sum + BigInt(part.size), 0n)
}

// Incomplete multipart uploads still count as stored data until aborted (aborting is free on R2).
export async function abortS3MultipartUpload(config: S3Config, key: string, uploadId: string) {
  const client = createS3Client(config)
  await client.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId }))
}

export async function deleteS3ObjectByKey(config: S3Config, key: string) {
  const client = createS3Client(config)
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
}

export async function deleteS3Object(file: FileWithAccount) {
  const config = await getS3ConfigForAccount(file.connectedAccountId)
  const client = createS3Client(config)
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: file.providerFileId }))
}

export async function syncS3Quota(accountId: string) {
  const config = await getS3ConfigForAccount(accountId)
  const client = createS3Client(config)
  let usedBytes = 0n
  let continuationToken: string | undefined
  do {
    const response = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, ContinuationToken: continuationToken }))
    for (const object of response.Contents ?? []) usedBytes += BigInt(object.Size ?? 0)
    continuationToken = response.NextContinuationToken
  } while (continuationToken)

  const quotaBytes = effectiveQuotaBytes(config)
  const availableBytes = quotaBytes === null ? null : (quotaBytes > usedBytes ? quotaBytes - usedBytes : 0n)
  return prisma.storageAccount.upsert({
    where: { connectedAccountId: accountId },
    create: {
      connectedAccountId: accountId,
      totalBytes: quotaBytes,
      usedBytes,
      availableBytes,
      lastSyncedAt: new Date(),
    },
    update: {
      totalBytes: quotaBytes,
      usedBytes,
      availableBytes,
      lastSyncedAt: new Date(),
    },
  })
}

export async function streamS3File(file: FileWithAccount, range: string | undefined, res: Response, options: StreamOptions = {}) {
  const config = await getS3ConfigForAccount(file.connectedAccountId)
  const client = createS3Client(config)
  const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: file.providerFileId, Range: range }))

  res.status(response.ContentRange ? 206 : 200)
  res.setHeader('Content-Type', response.ContentType ?? file.mimeType)
  res.setHeader('Accept-Ranges', 'bytes')
  if (options.disposition) res.setHeader('Content-Disposition', contentDisposition(options.disposition, file.name))
  if (response.ContentLength !== undefined) res.setHeader('Content-Length', response.ContentLength.toString())
  if (response.ContentRange) res.setHeader('Content-Range', response.ContentRange)

  const body = response.Body as Readable | undefined
  if (!body) return res.end()
  return body.pipe(res)
}
