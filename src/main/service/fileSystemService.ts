import { app, shell } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import fs from 'fs/promises'
import path from 'path'
import type { WebContents } from 'electron'
import type { Result } from '../interface/Result'

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
  if (!target.startsWith(root + path.sep)) return { ok: false as const, error: '这不是工作空间内的路径' }
  return { ok: true as const, root, target }
}

const toFsEntryFromDirent = (root: string, parentAbs: string, d: import('fs').Dirent): FsEntry => {
  const abs = path.join(parentAbs, d.name)
  const rel = path.relative(root, abs)
  return {
    name: d.name,
    relativePath: toPosix(rel),
    isDirectory: d.isDirectory(),
    size: 0,
    mtimeMs: 0,
  }
}

const ensureDir = async (p: string) => {
  await fs.mkdir(p, { recursive: true })
}

const pathExists = async (p: string) => {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

const safeRename = async (oldPath: string, newPath: string) => {
  try {
    await fs.rename(oldPath, newPath)
  } catch (error: any) {
    if (error.code === 'EXDEV') {
      await fs.cp(oldPath, newPath, { recursive: true })
      await fs.rm(oldPath, { recursive: true, force: true })
    } else {
      throw error
    }
  }
}

const getTrashDir = (workspaceId: string) => {
  return path.join(app.getPath('appData'), 'workspace-meta', 'with-you', 'trash', workspaceId)
}

export const fileSystemService = {
  async listDir(workspacePath: string, dirRelativePath: string): Promise<Result<FsEntry[]>> {
    try {
      const resolved = resolveInWorkspace(workspacePath, dirRelativePath || '.')
      if (!resolved.ok) return { success: false, error: resolved.error }

      const items = await fs.readdir(resolved.target, { withFileTypes: true })
      const entries = items.map((d) => toFsEntryFromDirent(resolved.root, resolved.target, d))

      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      return { success: true, data: entries }
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return { success: false, error: `目录不存在: ${dirRelativePath}` }
      }
      return { success: false, error: `列出目录失败: ${error?.message ?? String(error)}` }
    }
  },

  async createFolder(workspacePath: string, parentDirRelativePath: string, name: string): Promise<Result<string>> {
    try {
      const resolvedParent = resolveInWorkspace(workspacePath, parentDirRelativePath || '.')
      if (!resolvedParent.ok) return { success: false, error: resolvedParent.error }

      const folderName = name.trim()
      if (!folderName) return { success: false, error: '文件夹名称不能为空' }
      const destAbs = path.join(resolvedParent.target, folderName)
      const destRel = toPosix(path.relative(resolvedParent.root, destAbs))
      await fs.mkdir(destAbs, { recursive: false })
      return { success: true, data: destRel }
    } catch (error: any) {
      return { success: false, error: `创建目录失败: ${error?.message ?? String(error)}` }
    }
  },

  async createFile(workspacePath: string, parentDirRelativePath: string, name: string): Promise<Result<string>> {
    try {
      const resolvedParent = resolveInWorkspace(workspacePath, parentDirRelativePath || '.')
      if (!resolvedParent.ok) return { success: false, error: resolvedParent.error }

      const fileName = name.trim()
      if (!fileName || fileName === '.md') return { success: false, error: '文件名不能为空' }
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

      if (await pathExists(toResolved.target)) {
        return { success: false, error: '目标路径已存在' }
      }

      await ensureDir(path.dirname(toResolved.target))
      await safeRename(fromResolved.target, toResolved.target)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: `移动失败: ${error?.message ?? String(error)}` }
    }
  },

  async rename(workspacePath: string, targetRelativePath: string, newName: string): Promise<Result<string>> {
    try {
      const targetResolved = resolveInWorkspace(workspacePath, targetRelativePath)
      if (!targetResolved.ok) return { success: false, error: targetResolved.error }

      const newNameTrimmed = newName.trim()
      if (!newNameTrimmed) return { success: false, error: '新名称不能为空' }
      const newPath = path.join(path.dirname(targetResolved.target), newNameTrimmed)
      if (await pathExists(newPath)) {
        return { success: false, error: '新名称已存在' }
      }
      await safeRename(targetResolved.target, newPath)
      return { success: true, data: toPosix(path.relative(targetResolved.root, newPath)) }
    } catch (error: any) {
      return { success: false, error: `重命名失败: ${error?.message ?? String(error)}` }
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
      await safeRename(targetResolved.target, trashAbs)
      return { success: true, data: { trashRelativePath: toPosix(path.relative(trashDir, trashAbs)) } }
    } catch (error: any) {
      return { success: false, error: `删除失败: ${error?.message ?? String(error)}` }
    }
  },

  async isFile(workspacePath: string, targetRelativePath: string): Promise<Result<boolean>> {
    try {
      const stats = await fs.stat(path.join(workspacePath, targetRelativePath))
      return { success: true, data: stats.isFile() }
    } catch (error: any) {
      return { success: false, error: `检查文件类型失败: ${error?.message ?? String(error)}` }
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
      if (!trashAbs.startsWith(path.resolve(trashDir) + path.sep)) return { success: false, error: '无效的回收站路径' }

      const restoreResolved = resolveInWorkspace(workspacePath, restoreToRelativePath)
      if (!restoreResolved.ok) return { success: false, error: restoreResolved.error }

      await ensureDir(path.dirname(restoreResolved.target))
      await safeRename(trashAbs, restoreResolved.target)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: `恢复失败: ${error?.message ?? String(error)}` }
    }
  },

  async emptyTrash(workspaceId: string): Promise<Result<void>> {
    try {
      const trashDir = getTrashDir(workspaceId)
      await fs.rm(trashDir, { recursive: true, force: true })
      return { success: true }
    } catch (error: any) {
      return { success: false, error: `清空回收站失败: ${error?.message ?? String(error)}` }
    }
  },
}

type WatchState = {
  workspacePath: string
  watcher: FSWatcher
  watchedTargets: Set<string>
}

const watchers = new Map<number, WatchState>()

const defaultWatchIgnored = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.with-you/**',
]

export const fileWatchService = {
  start(workspaceId: string, workspacePath: string, webContents: WebContents) {
    const existing = watchers.get(webContents.id)
    if (existing) {
      watchers.delete(webContents.id)
      existing.watcher.close().catch(() => {})
    }

    const watcher = chokidar.watch(workspacePath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 25 },
      depth: 1,
      ignored: defaultWatchIgnored,
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

    const watchedTargets = new Set<string>()
    watchedTargets.add(path.resolve(workspacePath))

    watchers.set(webContents.id, { workspacePath, watcher, watchedTargets })

    webContents.once('destroyed', async () => {
      await this.stop(webContents)
    })
  },

  add(workspaceId: string, workspacePath: string, webContents: WebContents, relativePaths: string[]) {
    if (!Array.isArray(relativePaths) || relativePaths.length === 0) return

    if (!watchers.get(webContents.id)) {
      this.start(workspaceId, workspacePath, webContents)
    }

    const state = watchers.get(webContents.id)
    if (!state) return

    const toAdd: string[] = []
    for (const rel of relativePaths) {
      const resolved = resolveInWorkspace(state.workspacePath, rel || '.')
      if (!resolved.ok) continue
      const abs = path.resolve(resolved.target)
      if (state.watchedTargets.has(abs)) continue
      state.watchedTargets.add(abs)
      toAdd.push(abs)
    }

    if (toAdd.length > 0) {
      try {
        state.watcher.add(toAdd)
      } catch {
        // 蹇界暐娣诲姞鐩戝惉璺緞鏃剁殑閿欒
      }
    }
  },

  async stop(webContents: WebContents) {
    const existing = watchers.get(webContents.id)
    if (!existing) return
    watchers.delete(webContents.id)
    await existing.watcher.close()
  },
}
