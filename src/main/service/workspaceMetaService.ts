import fs from 'fs/promises'
import path from 'path'
import type { Result } from '../interface/Result'
import { workspaceService } from './workspaceService'

export interface WorkspaceMeta {
  expandedDirs: string[]
  selectedPaths: string[]
  noteOrder: Record<string, string[]>
  openedFiles?: string[]
  activeFile?: string
  fileSessions?: Record<string, any>
  activeSidebarPanel?: 'files' | 'outline' | null
  sidebarPanels?: { id: 'files' | 'outline'; size: number }[]
}

const META_DIR_NAME = '.looma'
const META_FILE_NAME = 'workspace.json'

// Helper to get workspace root path by ID
const getWorkspacePath = async (workspaceId: string): Promise<string | null> => {
  const stateRes = await workspaceService.getState()
  if (!stateRes.success || !stateRes.data) return null
  const ws = stateRes.data.workspaces.find(w => w.id === workspaceId)
  return ws ? ws.path : null
}

const getMetaDirPath = async (workspaceId: string): Promise<string | null> => {
  const wsPath = await getWorkspacePath(workspaceId)
  if (!wsPath) return null
  return path.join(wsPath, META_DIR_NAME)
}

const getMetaPath = async (workspaceId: string): Promise<string | null> => {
  const dirPath = await getMetaDirPath(workspaceId)
  if (!dirPath) return null
  return path.join(dirPath, META_FILE_NAME)
}

const defaultMeta: WorkspaceMeta = {
  expandedDirs: [],
  selectedPaths: [],
  noteOrder: {},
}

// Simple file locking mechanism for concurrency
const lockFile = async (filePath: string, maxRetries = 5, retryDelay = 50) => {
  const lockPath = `${filePath}.lock`
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' })
      return async () => {
        try { await fs.unlink(lockPath) } catch {}
      }
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err
      await new Promise(resolve => setTimeout(resolve, retryDelay))
    }
  }
  // Force take lock if stale
  try { await fs.unlink(lockPath) } catch {}
  await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' })
  return async () => {
    try { await fs.unlink(lockPath) } catch {}
  }
}

export const workspaceMetaService = {
  async getMeta(workspaceId: string): Promise<Result<WorkspaceMeta>> {
    let unlock: (() => Promise<void>) | null = null
    try {
      const metaPath = await getMetaPath(workspaceId)
      if (!metaPath) return { success: true, data: defaultMeta }

      let raw: string | null = null
      try {
        unlock = await lockFile(metaPath)
        raw = await fs.readFile(metaPath, 'utf-8')
      } catch (err: any) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err
      }

      if (!raw) {
        if (unlock) await unlock()
        // Force write default meta so file is created immediately
        await workspaceMetaService.setMeta(workspaceId, defaultMeta)
        return { success: true, data: defaultMeta }
      }

      const parsed = JSON.parse(raw) as Partial<WorkspaceMeta>
      if (unlock) await unlock()
      
      const migratedMeta = {
        expandedDirs: Array.isArray(parsed.expandedDirs) ? parsed.expandedDirs : [],
        selectedPaths: Array.isArray(parsed.selectedPaths) ? parsed.selectedPaths : (typeof (parsed as any).selectedDir === 'string' && (parsed as any).selectedDir ? [(parsed as any).selectedDir] : []),
        noteOrder: typeof parsed.noteOrder === 'object' && parsed.noteOrder ? (parsed.noteOrder as any) : {},
        openedFiles: Array.isArray(parsed.openedFiles) ? parsed.openedFiles : [],
        activeFile: typeof parsed.activeFile === 'string' ? parsed.activeFile : undefined,
        fileSessions: typeof parsed.fileSessions === 'object' && parsed.fileSessions ? parsed.fileSessions : {},
        activeSidebarPanel:
          parsed.activeSidebarPanel === null || parsed.activeSidebarPanel === 'files' || parsed.activeSidebarPanel === 'outline'
            ? parsed.activeSidebarPanel
            : undefined,
        sidebarPanels: Array.isArray(parsed.sidebarPanels) ? parsed.sidebarPanels : undefined,
      }
      
      return {
        success: true,
        data: migratedMeta,
      }
    } catch (err) {
      if (unlock) await unlock()
      return { success: true, data: defaultMeta } // Graceful degradation
    }
  },

  async setMeta(workspaceId: string, meta: WorkspaceMeta): Promise<Result<void>> {
    let unlock: (() => Promise<void>) | null = null
    try {
      const metaDirPath = await getMetaDirPath(workspaceId)
      if (!metaDirPath) return { success: false, error: '工作空间路径不存在' }
      
      try {
        const stat = await fs.stat(metaDirPath)
        if (stat.isFile()) {
          await fs.unlink(metaDirPath)
        }
      } catch {}

      try {
        await fs.mkdir(metaDirPath, { recursive: true })
      } catch {}

      const metaPath = await getMetaPath(workspaceId)
      if (!metaPath) return { success: false, error: '工作空间路径不存在' }

      unlock = await lockFile(metaPath)
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
      
      if (unlock) await unlock()
      return { success: true }
    } catch (error: any) {
      if (unlock) await unlock()
      return { success: false, error: `保存工作空间元数据失败: ${error?.message ?? String(error)}` }
    }
  },
}
