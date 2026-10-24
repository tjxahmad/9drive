import { Router } from 'express'

export const publicRouter = Router()

// Public share links are disabled: files are only readable by the signed-in owner.
publicRouter.use((_req, res) => {
  return res.status(404).json({ code: 'PUBLIC_SHARING_DISABLED', message: 'Public file sharing is disabled.' })
})
