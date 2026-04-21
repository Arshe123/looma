import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import type { Result } from '../interfaces/Result'

export interface WorkspaceMeta {
  expandedDirs: string[]
  selectedDir: string
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
  selectedDir: '',
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
          selectedDir: typeof parsed.selectedDir === 'string' ? parsed.selectedDir : '',
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

