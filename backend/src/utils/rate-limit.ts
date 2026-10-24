type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()

// Small in-memory limiter for auth endpoints (brute-force protection). Resets when the server restarts.
export function isRateLimited(key: string, limit: number, windowMs: number) {
  const now = Date.now()
  if (buckets.size > 10_000) {
    for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketKey)
  }
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return false
  }
  bucket.count += 1
  return bucket.count > limit
}
