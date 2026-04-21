import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import type { Result } from '../interfaces/Result'

export interface WorkspaceMeta {
  expandedDirs: string[]
  selectedPaths: string[]
  noteOrder: Record<string, string[]>
}

const getMetaDir = () => {
  return path.join(app.getPath('appData'), 'workspace-meta', 'with-you', 'workspaces')
}

const getMetaPath = (workspaceId: string) => {
  return path.join(getMetaDir(), `${workspaceId}.json`)
}

const ensureMetaDir = async () => {
  await fs.mkdir(getMetaDir(), { recursive: true })
}

const defaultMeta: WorkspaceMeta = {
  expandedDirs: [],
  selectedPaths: [],
  noteOrder: {},
}

export const workspaceMetaService = {
  async getMeta(workspaceId: string): Promise<Result<WorkspaceMeta>> {
    try {
      await ensureMetaDir()
      const raw = await fs.readFile(getMetaPath(workspaceId), 'utf-8')
      const parsed = JSON.parse(raw) as Partial<WorkspaceMeta>
      return {
        success: true,
        data: {
          expandedDirs: Array.isArray(parsed.expandedDirs) ? parsed.expandedDirs : [],
          selectedPaths: Array.isArray(parsed.selectedPaths) ? parsed.selectedPaths : (typeof (parsed as any).selectedDir === 'string' && (parsed as any).selectedDir ? [(parsed as any).selectedDir] : []),
          noteOrder: typeof parsed.noteOrder === 'object' && parsed.noteOrder ? (parsed.noteOrder as any) : {},
        },
      }
    } catch {
      return { success: true, data: defaultMeta }
    }
  },

  async setMeta(workspaceId: string, meta: WorkspaceMeta): Promise<Result<void>> {
    try {
      await ensureMetaDir()
      await fs.writeFile(getMetaPath(workspaceId), JSON.stringify(meta, null, 2), 'utf-8')
      return { success: true }
    } catch (error: any) {
      return { success: false, error: `Failed to save workspace meta: ${error?.message ?? String(error)}` }
    }
  },
}

