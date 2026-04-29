import { app } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import fs from 'fs/promises'
import path from 'path'
import type { WebContents } from 'electron'
import type { Result } from '../interfaces/Result'

export interface FsEntry {
  name: string
  relativePath: string
  isDirectory: boolean
  size: number
  mtimeMs: number
}

const toPosix = (p: string) => p.split(path.sep).join('/')

const resolveInWorkspace = (workspacePath: string, relativePath: string) => {
  const root = path.resolve(workspacePath)
  const target = path.resolve(root, relativePath)
  if (target === root) return { ok: true as const, root, target }
  if (!target.startsWith(root + path.sep)) return { ok: false as const, error: 'Path is outside workspace' }
  return { ok: true as const, root, target }
}

const ensureDir = async (p: string) => {
  await fs.mkdir(p, { recursive: true })
}

const getTrashDir = (workspaceId: string) => {
  return path.join(app.getPath('appData'), 'workspace-meta', 'with-you', 'trash', workspaceId)
}

const statToEntry = (name: string, rel: string, stat: any): FsEntry => {
  return {
    name,
    relativePath: toPosix(rel),
    isDirectory: stat.isDirectory(),
    size: typeof stat.size === 'number' ? stat.size : 0,
    mtimeMs: typeof stat.mtimeMs === 'number' ? stat.mtimeMs : 0,
  }
}

export const fileSystemService = {
  async listDir(workspacePath: string, dirRelativePath: string): Promise<Result<FsEntry[]>> {
    try {
      const resolved = resolveInWorkspace(workspacePath, dirRelativePath || '.')
      if (!resolved.ok) return { success: false, error: resolved.error }

      try {
        await fs.access(resolved.target)
      } catch {
        return { success: false, error: `Directory not found: ${dirRelativePath}` }
      }

      const items = await fs.readdir(resolved.target, { withFileTypes: true })
      const entries = await Promise.all(
        items.map(async (d) => {
          const abs = path.join(resolved.target, d.name)
          const rel = path.relative(resolved.root, abs)
          const st = await fs.stat(abs)
          return statToEntry(d.name, rel, st)
        }),
      )

      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      return { success: true, data: entries }
    } catch (error: any) {
      return { success: false, error: `Failed to list directory: ${error?.message ?? String(error)}` }
    }
  },

  async createFolder(workspacePath: string, parentDirRelativePath: string, name: string): Promise<Result<string>> {
    try {
      const resolvedParent = resolveInWorkspace(workspacePath, parentDirRelativePath || '.')
      if (!resolvedParent.ok) return { success: false, error: resolvedParent.error }

      const folderName = name.trim()
      if (!folderName) return { success: false, error: 'Folder name is required' }
      const destAbs = path.join(resolvedParent.target, folderName)
      const destRel = toPosix(path.relative(resolvedParent.root, destAbs))
      await fs.mkdir(destAbs, { recursive: false })
      return { success: true, data: destRel }
    } catch (error: any) {
      return { success: false, error: `Failed to create folder: ${error?.message ?? String(error)}` }
    }
  },

  async createFile(workspacePath: string, parentDirRelativePath: string, name: string): Promise<Result<string>> {
    try {
      const resolvedParent = resolveInWorkspace(workspacePath, parentDirRelativePath || '.')
      if (!resolvedParent.ok) return { success: false, error: resolvedParent.error }

      const fileName = name.trim()
      if (!fileName || fileName === '.md') return { success: false, error: 'File name is required' }
      const destAbs = path.join(resolvedParent.target, fileName)
      const destRel = toPosix(path.relative(resolvedParent.root, destAbs))
      await fs.writeFile(destAbs, '', { encoding: 'utf-8', flag: 'wx' })
      return { success: true, data: destRel }
    } catch (error: any) {
      return { success: false, error: `Failed to create file: ${error?.message ?? String(error)}` }
    }
  },

  async move(workspacePath: string, fromRelativePath: string, toRelativePath: string): Promise<Result<void>> {
    try {
      const fromResolved = resolveInWorkspace(workspacePath, fromRelativePath)
      if (!fromResolved.ok) return { success: false, error: fromResolved.error }
      const toResolved = resolveInWorkspace(workspacePath, toRelativePath)
      if (!toResolved.ok) return { success: false, error: toResolved.error }

      try{
        await fs.access(toResolved.target)
        return { success: false, error: 'Target path already exists' }
      } catch (error: any) {
        // Target path is valid
      }

      await ensureDir(path.dirname(toResolved.target))
      await fs.rename(fromResolved.target, toResolved.target)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: `Failed to move: ${error?.message ?? String(error)}` }
    }
  },

  async rename(workspacePath: string, targetRelativePath: string, newName: string): Promise<Result<string>> {
    try {
      const targetResolved = resolveInWorkspace(workspacePath, targetRelativePath)
      if (!targetResolved.ok) return { success: false, error: targetResolved.error }

      const newNameTrimmed = newName.trim()
      if (!newNameTrimmed) return { success: false, error: 'New name is required' }
      const newPath = path.join(path.dirname(targetResolved.target), newNameTrimmed)
      try{
        await fs.access(newPath)
        return { success: false, error: 'New name already exists' }
      } catch (error: any) {
        // New name is valid
      }
      await fs.rename(targetResolved.target, newPath)
      return { success: true, data: toPosix(path.relative(targetResolved.root, newPath)) }
    } catch (error: any) {
      return { success: false, error: `Failed to rename: ${error?.message ?? String(error)}` }
    }
  },

  async softDelete(workspaceId: string, workspacePath: string, targetRelativePath: string): Promise<Result<{ trashRelativePath: string }>> {
    try {
      const targetResolved = resolveInWorkspace(workspacePath, targetRelativePath)
      if (!targetResolved.ok) return { success: false, error: targetResolved.error }

      const trashDir = getTrashDir(workspaceId)
      await ensureDir(trashDir)
      const base = path.basename(targetResolved.target)
      const stamp = Date.now()
      const trashAbs = path.join(trashDir, `${stamp}_${base}`)
      await fs.rename(targetResolved.target, trashAbs)
      return { success: true, data: { trashRelativePath: toPosix(path.relative(trashDir, trashAbs)) } }
    } catch (error: any) {
      return { success: false, error: `Failed to delete: ${error?.message ?? String(error)}` }
    }
  },

  async restoreFromTrash(
    workspaceId: string,
    workspacePath: string,
    trashRelativePath: string,
    restoreToRelativePath: string,
  ): Promise<Result<void>> {
    try {
      const trashDir = getTrashDir(workspaceId)
      const trashAbs = path.resolve(trashDir, trashRelativePath)
      if (!trashAbs.startsWith(path.resolve(trashDir) + path.sep)) return { success: false, error: 'Invalid trash path' }

      const restoreResolved = resolveInWorkspace(workspacePath, restoreToRelativePath)
      if (!restoreResolved.ok) return { success: false, error: restoreResolved.error }

      await ensureDir(path.dirname(restoreResolved.target))
      await fs.rename(trashAbs, restoreResolved.target)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: `Failed to restore: ${error?.message ?? String(error)}` }
    }
  },
}

type WatchKey = string

const watchers = new Map<number, { workspaceId: string; watcher: FSWatcher }>()

export const fileWatchService = {
  start(workspaceId: string, workspacePath: string, webContents: WebContents) {
    const existing = watchers.get(webContents.id)
    if (existing) {
      if (existing.workspaceId === workspaceId) return
      watchers.delete(webContents.id)
      existing.watcher.close().catch(() => {})
    }

    const watcher = chokidar.watch(workspacePath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 25 },
      depth: 20,
    })

    const send = (event: string, absPath: string) => {
      const rel = toPosix(path.relative(workspacePath, absPath))
      webContents.send('fs:event', { workspaceId, event, relativePath: rel })
    }

    watcher
      .on('add', (p) => send('add', p))
      .on('addDir', (p) => send('addDir', p))
      .on('change', (p) => send('change', p))
      .on('unlink', (p) => send('unlink', p))
      .on('unlinkDir', (p) => send('unlinkDir', p))

    watchers.set(webContents.id, { workspaceId, watcher })

    webContents.once('destroyed', async () => {
      await this.stop(webContents)
    })
  },

  async stop(webContents: WebContents) {
    const existing = watchers.get(webContents.id)
    if (!existing) return
    watchers.delete(webContents.id)
    await existing.watcher.close()
  },
}

export const fileWatchDebug = {
  getActiveCount() {
    return watchers.size
  },
  getActiveWorkspaceId(webContentsId: number) {
    return watchers.get(webContentsId)?.workspaceId ?? null
  },
}
