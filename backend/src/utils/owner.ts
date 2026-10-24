import type { Prisma, User } from '@prisma/client'
import { env } from '../config/env.js'
import { prisma } from '../config/prisma.js'
import { randomToken } from './crypto.js'
import { hashPassword } from './password.js'

// Single-owner mode: exactly one account may use this 9Drive instance.
// With OWNER_EMAIL set, the owner is the account with that email; otherwise it is the first account ever created.

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

export async function isOwner(user: Pick<User, 'id' | 'email' | 'status'>) {
  if (user.status !== 'active') return false
  if (env.OWNER_EMAIL) return normalizeEmail(user.email) === normalizeEmail(env.OWNER_EMAIL)
  const firstUser = await prisma.user.findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } })
  return firstUser?.id === user.id
}

export async function canCreateOwner(email: string) {
  if (env.OWNER_EMAIL) {
    if (normalizeEmail(email) !== normalizeEmail(env.OWNER_EMAIL)) return false
    return !(await prisma.user.findUnique({ where: { email }, select: { id: true } }))
  }
  return (await prisma.user.count()) === 0
}

// Creates the owner account, or returns null when registration is closed.
// The ownership check runs again after insert so two simultaneous sign-ups cannot both succeed.
export async function createOwnerUser(data: Prisma.UserCreateInput) {
  if (!(await canCreateOwner(data.email))) return null
  const user = await prisma.user.create({ data })
  if (await isOwner(user)) return user
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined)
  return null
}

// Google sign-in: logs in the owner, or creates the owner on first use. Returns null for anyone else.
export async function findOrCreateOwnerForGoogle(email: string, name: string) {
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    if (!(await isOwner(existing))) return null
    return prisma.user.update({ where: { id: existing.id }, data: { name } })
  }
  return createOwnerUser({ email, name, passwordHash: await hashPassword(randomToken(32)) })
}
