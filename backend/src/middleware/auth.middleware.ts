import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../config/prisma.js'
import { isOwner } from '../utils/owner.js'
import { verifyAccessToken } from '../utils/jwt.js'

export type AuthRequest = Request & {
  user?: { id: string; sessionId: string }
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const header = req.header('Authorization')
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Bearer token required.' })
    const payload = verifyAccessToken(header.slice(7))
    const session = await prisma.userSession.findUnique({ where: { id: payload.sid }, include: { user: { select: { id: true, email: true, status: true } } } })
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== payload.sub) return res.status(401).json({ code: 'AUTH_SESSION_EXPIRED', message: 'Session expired.' })
    // Single-owner mode: every authenticated route is owner-only.
    if (!(await isOwner(session.user))) return res.status(403).json({ code: 'AUTH_NOT_OWNER', message: 'Only the owner can use this 9Drive.' })
    req.user = { id: payload.sub, sessionId: payload.sid }
    return next()
  } catch {
    return res.status(401).json({ code: 'AUTH_INVALID_TOKEN', message: 'Invalid token.' })
  }
}
