import { Router } from 'express'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { getLockState, isFolderBlocked } from '../folders/folder-lock.js'

export const auditLogRouter = Router()

type LogDetails = { name?: string; names?: string[]; folderId?: string | null; folderIds?: string[]; parentId?: string | null; [key: string]: unknown }

function parseDetails(metadata: unknown): LogDetails | null {
  if (typeof metadata === 'string') {
    try { return JSON.parse(metadata) as LogDetails } catch { return null }
  }
  return metadata && typeof metadata === 'object' ? metadata as LogDetails : null
}

auditLogRouter.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const logs = await prisma.auditLog.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 200
    })

    // While a folder is locked, the names of what is inside it are hidden here too.
    const state = await getLockState(req)
    const fileIds = logs.filter((log) => log.entityType === 'file' && log.entityId).map((log) => log.entityId!)
    const fileFolders = new Map((fileIds.length ? await prisma.file.findMany({ where: { id: { in: fileIds }, userId: req.user!.id }, select: { id: true, folderId: true } }) : []).map((file) => [file.id, file.folderId]))

    return res.json({
      logs: logs.map((log) => {
        const details = parseDetails(log.metadata)
        if (!details) return log
        const hidden = log.entityType === 'folder'
          ? isFolderBlocked(state, details.parentId !== undefined ? details.parentId : state.folders.get(log.entityId ?? '')?.parentId)
          : isFolderBlocked(state, details.folderId ?? (log.entityId ? fileFolders.get(log.entityId) : null)) || (details.folderIds ?? []).some((id) => isFolderBlocked(state, id))
        if (!hidden) return log
        const { names: _names, updates: _updates, ...rest } = details
        return { ...log, metadata: JSON.stringify({ ...rest, name: 'Item in a locked folder', locked: true }) }
      })
    })
  } catch (error) {
    return next(error)
  }
})
