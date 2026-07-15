import { app, shell } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import fs from 'fs/promises'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import type { WebContents } from 'electron'
import type { Result } from '../../../shared/types/Result'

export type WatchState = {
  workspacePath: string
  watcher: FSWatcher
  watchedTargets: Set<string>
}

export interface AgentFileProposal {
  path: string
  operation: 'create' | 'update'
  unified_diff: string
  expected_sha256: string | null
  proposed_sha256: string
  proposed_content: string
}

export interface AgentFileApplyResult {
  path: string
  operation: 'create' | 'update'
  sha256: string
}

interface FsEntry {
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

const MAX_AGENT_PATCH_BYTES = 200_000
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const isWithin = (root: string, target: string) => target === root || target.startsWith(root + path.sep)

const validateAgentRelativePath = (relativePath: string) => {
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || /^[/\\]{2}/.test(relativePath)) {
    throw new Error('无效的工作空间相对路径')
  }
  const parts = relativePath.replace(/\\/g, '/').split('/')
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':')
    || part.endsWith('.') || part.endsWith(' ') || part.toLowerCase() === '.looma' || reserved.test(part))) {
    throw new Error('路径包含不允许的目录段')
  }
  return parts
}

const assertNoLinksOrReparsePoints = async (root: string, parts: string[]) => {
  let current = root
  for (const part of parts) {
    current = path.join(current, part)
    try {
      const stats = await fs.lstat(current)
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
        throw new Error('Agent 文件修改不允许经过链接或特殊文件')
      }
    } catch (error: any) {
      if (error?.code === 'ENOENT') break
      throw error
    }
  }
}

export const applyAgentFileProposal = async (
  workspacePath: string,
  proposal: AgentFileProposal,
): Promise<Result<AgentFileApplyResult>> => {
  let tempPath = ''
  try {
    if (!proposal || !['create', 'update'].includes(proposal.operation)) throw new Error('无效的修改提案')
    const parts = validateAgentRelativePath(proposal.path)
    const root = await fs.realpath(path.resolve(workspacePath))
    const target = path.resolve(root, ...parts)
    if (!isWithin(root, target)) throw new Error('目标路径不在工作空间内')
    await assertNoLinksOrReparsePoints(root, parts)

    const parent = path.dirname(target)
    const parentReal = await fs.realpath(parent)
    if (!isWithin(root, parentReal)) throw new Error('目标目录不在工作空间内')
    const parentStats = await fs.lstat(parentReal)
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) throw new Error('目标父目录不安全')

    const proposed = Buffer.from(proposal.proposed_content, 'utf8')
    if (!proposal.proposed_content || proposed.length > MAX_AGENT_PATCH_BYTES || proposed.includes(0)) {
      throw new Error('提案内容为空、过大或不是文本')
    }
    if (!/^[a-f0-9]{64}$/.test(proposal.proposed_sha256) || sha256(proposed) !== proposal.proposed_sha256) {
      throw new Error('提案内容校验失败')
    }

    let mode: number | undefined
    if (proposal.operation === 'create') {
      if (proposal.expected_sha256 !== null) throw new Error('新建提案不能包含原文件 hash')
      try {
        await fs.lstat(target)
        throw new Error('目标文件已经存在')
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error
      }
    } else {
      if (!/^[a-f0-9]{64}$/.test(proposal.expected_sha256 || '')) throw new Error('更新提案缺少有效 hash')
      const targetStats = await fs.lstat(target)
      if (!targetStats.isFile() || targetStats.isSymbolicLink()) throw new Error('目标不是安全的普通文件')
      const current = await fs.readFile(target)
      if (current.length > MAX_AGENT_PATCH_BYTES || current.includes(0)) throw new Error('目标文件过大或不是文本')
      new TextDecoder('utf-8', { fatal: true }).decode(current)
      if (sha256(current) !== proposal.expected_sha256) throw new Error('文件已在审批期间发生变化，请重新生成修改提案')
      mode = targetStats.mode
    }

    await assertNoLinksOrReparsePoints(root, parts)
    if (await fs.realpath(parent) !== parentReal) throw new Error('目标目录在审批期间发生变化')
    if (proposal.operation === 'create') {
      try {
        await fs.lstat(target)
        throw new Error('目标文件已经存在')
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error
      }
    } else {
      const latestStats = await fs.lstat(target)
      if (!latestStats.isFile() || latestStats.isSymbolicLink()) throw new Error('目标文件类型在审批期间发生变化')
      const latest = await fs.readFile(target)
      if (sha256(latest) !== proposal.expected_sha256) throw new Error('文件已在审批期间发生变化，请重新生成修改提案')
    }

    tempPath = path.join(parentReal, `.looma-agent-${randomUUID()}.tmp`)
    const handle = await fs.open(tempPath, 'wx', mode)
    try {
      await handle.writeFile(proposed)
      await handle.sync()
    } finally {
      await handle.close()
    }

    if (proposal.operation === 'create') {
      // link() is the no-overwrite atomic commit: a concurrent creator makes it fail with EEXIST.
      await fs.link(tempPath, target)
      await fs.unlink(tempPath)
    } else {
      await fs.rename(tempPath, target)
    }
    tempPath = ''
    const written = await fs.readFile(target)
    if (sha256(written) !== sha256(proposed)) throw new Error('写入后的文件校验失败')
    return {
      success: true,
      data: { path: proposal.path.replace(/\\/g, '/'), operation: proposal.operation, sha256: sha256(written) },
    }
  } catch (error: any) {
    if (tempPath) await fs.unlink(tempPath).catch(() => {})
    return { success: false, error: error?.message || '应用文件修改失败', errorCode: 'AGENT_PATCH_APPLY_FAILED' }
  }
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
  return path.join(app.getPath('appData'), 'workspace-meta', 'looma', 'trash', workspaceId)
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
        return { success: false, error: `目录不存在: ${dirRelativePath}`, errorCode: 'ENOENT' }
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
      const oldPath = path.resolve(targetResolved.target)
      const newPath = path.resolve(path.dirname(oldPath), newNameTrimmed)
      const isCaseOnlyRename = process.platform === 'win32' && oldPath.toLowerCase() === newPath.toLowerCase()

      if (oldPath === newPath) {
        return { success: true, data: toPosix(path.relative(targetResolved.root, oldPath)) }
      }

      if (!isCaseOnlyRename && await pathExists(newPath)) {
        return { success: false, error: '新名称已存在' }
      }
      await safeRename(oldPath, newPath)
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
      if (!(await pathExists(trashDir))) return { success: true }

      const entries = await fs.readdir(trashDir)
      const failures: string[] = []

      for (const entry of entries) {
        const target = path.join(trashDir, entry)
        try {
          await shell.trashItem(target)
        } catch (error: any) {
          failures.push(`${entry}: ${error?.message ?? String(error)}`)
        }
      }

      if (failures.length > 0) {
        return { success: false, error: `清空回收站失败: ${failures.join('; ')}` }
      }

      return { success: true }
    } catch (error: any) {
      return { success: false, error: `清空回收站失败: ${error?.message ?? String(error)}` }
    }
  },
}

const watchers = new Map<number, WatchState>()

const defaultWatchIgnored = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.looma/**',
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
