import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../middleware/auth.middleware.js'
import { prisma } from '../../config/prisma.js'
import { decryptText, encryptText } from '../../utils/crypto.js'

export const systemRouter = Router()

// Remote code update (git pull / update.sh) and database backup/restore over HTTP were removed for security.
// Update manually with git, and back up MySQL with mysqldump on the machine itself.

const googleConfigSchema = z.object({
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().trim().max(512).optional(),
  redirectUri: z.string().trim().url().max(2048).optional().or(z.literal('')),
})

systemRouter.get('/google-config', requireAuth, async (req, res, next) => {
  try {
    const config = await prisma.providerConfig.findFirst({
      where: { userId: null, provider: 'google_drive', status: 'active' },
      orderBy: { createdAt: 'desc' }
    })

    const defaultRedirect = `${req.protocol}://${req.get('host')}/connected-accounts/google/callback`

    if (!config) {
      return res.json({
        exists: false,
        defaultRedirectUri: defaultRedirect
      })
    }

    let clientId = ''
    try {
      clientId = decryptText(config.clientIdEncrypted)
    } catch {
      clientId = ''
    }

    return res.json({
      exists: true,
      clientId,
      redirectUri: config.redirectUri,
      hasSecret: !!config.clientSecretEncrypted,
      defaultRedirectUri: defaultRedirect
    })
  } catch (error) {
    return next(error)
  }
})

systemRouter.post('/google-config', requireAuth, async (req, res, next) => {
  try {
    const parsed = googleConfigSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'Valid Client ID and redirect URI are required.' })
    }
    const { clientId, clientSecret, redirectUri } = parsed.data

    const defaultRedirect = `${req.protocol}://${req.get('host')}/connected-accounts/google/callback`
    const finalRedirectUri = redirectUri || defaultRedirect

    const scopes = [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ]

    // Reuse the current secret if a new one was not provided
    let finalSecret = clientSecret
    if (!finalSecret) {
      const oldConfig = await prisma.providerConfig.findFirst({
        where: { userId: null, provider: 'google_drive', status: 'active' },
        orderBy: { createdAt: 'desc' }
      })
      if (oldConfig) {
        try {
          finalSecret = decryptText(oldConfig.clientSecretEncrypted)
        } catch {
          // ignore
        }
      }
    }

    if (!finalSecret) {
      return res.status(400).json({ code: 'BAD_REQUEST', message: 'Client Secret is required for first-time setup.' })
    }

    const config = await prisma.$transaction(async (tx) => {
      // Disable old global active config
      await tx.providerConfig.updateMany({
        where: { userId: null, provider: 'google_drive', status: 'active' },
        data: { status: 'disabled' }
      })
      return tx.providerConfig.create({
        data: {
          userId: null,
          provider: 'google_drive',
          clientIdEncrypted: encryptText(clientId),
          clientSecretEncrypted: encryptText(finalSecret),
          redirectUri: finalRedirectUri,
          scopes,
          status: 'active'
        }
      })
    })

    return res.status(201).json({
      status: 'success',
      message: 'Global Google OAuth configuration updated successfully.',
      id: config.id
    })
  } catch (error) {
    return next(error)
  }
})
