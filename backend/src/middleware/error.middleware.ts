import type { NextFunction, Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'

// Throw this for expected failures that should reach the user with a clear message.
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

export function errorMiddleware(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof HttpError) return res.status(error.status).json({ code: error.code, message: error.message })
  if (error instanceof ZodError) {
    const issue = error.issues[0]
    const field = issue?.path.join('.')
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: issue ? `${field ? `${field}: ` : ''}${issue.message}` : 'Invalid request data.' })
  }
  // Database errors carry query details and source paths; log them here and send only a generic message.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return res.status(404).json({ code: 'NOT_FOUND', message: 'Not found.' })
  if (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientValidationError ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError
  ) {
    console.error('Database error:', error.message)
    return res.status(500).json({ code: 'DATABASE_ERROR', message: 'Database error. Make sure MySQL is running.' })
  }
  // Malformed JSON bodies and other client errors from Express middleware.
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 500
  if (status >= 400 && status < 500) return res.status(status).json({ code: 'BAD_REQUEST', message: 'Invalid request.' })
  const message = error instanceof Error ? error.message : 'Internal server error'
  return res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message })
}
