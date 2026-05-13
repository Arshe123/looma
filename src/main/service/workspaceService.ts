import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import type { Result } from '../interface/Result'

export interface Workspace {
  id: string
  name: string
  path: string
  createdAt: number
  lastOpenedAt: number
}

interface WorkspaceState {
  workspaces: Workspace[]
  order: string[]
  activeId: string | null
}

const getMetaRootDir = () => {
  return path.join(app.getPath('appData'), 'workspace-meta', 'looma')
}

const getWorkspacesJsonPath = () => {
  return path.join(getMetaRootDir(), 'workspaces.json')
}

const ensureMetaRootDir = async () => {
  await fs.mkdir(getMetaRootDir(), { recursive: true })
}

const isDirectory = async (p: string) => {
  const stat = await fs.stat(p)
  return stat.isDirectory()
}

const readState = async (): Promise<WorkspaceState> => {
  await ensureMetaRootDir()
  try {
    const raw = await fs.readFile(getWorkspacesJsonPath(), 'utf-8')
    const parsed = JSON.parse(raw) as WorkspaceState
    const workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces : []
    const order = Array.isArray(parsed.order) ? parsed.order : []
    const activeId = parsed.activeId ?? null
    const knownIds = new Set(workspaces.map((w) => w.id))
    const normalizedOrder = order.filter((id) => knownIds.has(id))
    const missing = workspaces.map((w) => w.id).filter((id) => !normalizedOrder.includes(id))
    return {
      workspaces,
      order: normalizedOrder.concat(missing),
      activeId: activeId && knownIds.has(activeId) ? activeId : (normalizedOrder[0] ?? missing[0] ?? null),
    }
  } catch {
    return { workspaces: [], order: [], activeId: null }
  }
}

const writeState = async (state: WorkspaceState) => {
  await ensureMetaRootDir()
  await fs.writeFile(getWorkspacesJsonPath(), JSON.stringify(state, null, 2), 'utf-8')
}

export const workspaceService = {
  async getState(): Promise<Result<WorkspaceState>> {
    try {
      const state = await readState()
      return { success: true, data: state }
    } catch (error: any) {
      return { success: false, error: `Failed to load workspaces: ${error?.message ?? String(error)}` }
    }
  },

  async listWorkspaces(): Promise<Result<Workspace[]>> {
    const stateResult = await this.getState()
    if (!stateResult.success || !stateResult.data) return { success: false, error: stateResult.error || 'Failed to load workspaces' }
    const { workspaces, order } = stateResult.data
    const map = new Map(workspaces.map((w) => [w.id, w] as const))
    return { success: true, data: order.map((id) => map.get(id)).filter(Boolean) as Workspace[] }
  },

  async createWorkspace(workspacePath: string, name?: string): Promise<Result<Workspace>> {
    try {
      if (!(await isDirectory(workspacePath))) {
        return { success: false, error: 'Selected path is not a directory' }
      }

      const state = await readState()
      const existing = state.workspaces.find((w) => path.resolve(w.path) === path.resolve(workspacePath))
      if (existing) {
        state.activeId = existing.id
        existing.lastOpenedAt = Date.now()
        await writeState(state)
        return { success: true, data: existing }
      }

      const workspace: Workspace = {
        id: randomUUID(),
        name: name?.trim() ? name.trim() : path.basename(workspacePath),
        path: workspacePath,
        createdAt: Date.now(),
        lastOpenedAt: Date.now(),
      }

      state.workspaces.push(workspace)
      state.order.push(workspace.id)
      state.activeId = workspace.id
      await writeState(state)
      return { success: true, data: workspace }
    } catch (error: any) {
      return { success: false, error: `Failed to create workspace: ${error?.message ?? String(error)}` }
    }
  },

  async renameWorkspace(id: string, newName: string): Promise<Result<void>> {
    try {
      const state = await readState()
      const ws = state.workspaces.find((w) => w.id === id)
      if (!ws) return { success: false, error: 'Workspace not found' }
      ws.name = newName.trim() || ws.name
      await writeState(state)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: `Failed to rename workspace: ${error?.message ?? String(error)}` }
    }
  },

  async removeWorkspace(id: string): Promise<Result<void>> {
    try {
      const state = await readState()
      const before = state.workspaces.length
      state.workspaces = state.workspaces.filter((w) => w.id !== id)
      if (state.workspaces.length === before) return { success: false, error: 'Workspace not found' }
      state.order = state.order.filter((x) => x !== id)
      if (state.activeId === id) state.activeId = state.order[0] ?? state.workspaces[0]?.id ?? null
      await writeState(state)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: `Failed to remove workspace: ${error?.message ?? String(error)}` }
    }
  },

  async reorderWorkspaces(order: string[]): Promise<Result<void>> {
    try {
      const state = await readState()
      const knownIds = new Set(state.workspaces.map((w) => w.id))
      const next = order.filter((id) => knownIds.has(id))
      const missing = state.workspaces.map((w) => w.id).filter((id) => !next.includes(id))
      state.order = next.concat(missing)
      await writeState(state)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: `Failed to reorder workspaces: ${error?.message ?? String(error)}` }
    }
  },

  async checkExists(id: string): Promise<Result<{ exists: boolean, path: string, name: string }>> {
    try {
      const state = await readState()
      const ws = state.workspaces.find((w) => w.id === id)
      if (!ws) return { success: false, error: 'Workspace not found' }
      const isDir = await isDirectory(ws.path).catch(() => false)
      return { success: true, data: { exists: isDir, path: ws.path, name: ws.name } }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  },

  async recreateWorkspace(id: string): Promise<Result<void>> {
    try {
      const state = await readState()
      const ws = state.workspaces.find((w) => w.id === id)
      if (!ws) return { success: false, error: 'Workspace not found' }
      
      await fs.mkdir(ws.path, { recursive: true })
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  },

  async setActiveWorkspace(id: string | null): Promise<Result<void>> {
    try {
      const state = await readState()
      if (!id) {
        state.activeId = null
        await writeState(state)
        return { success: true }
      }
      const ws = state.workspaces.find((w) => w.id === id)
      if (!ws) return { success: false, error: 'Workspace not found' }
      ws.lastOpenedAt = Date.now()
      state.activeId = id
      await writeState(state)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: `Failed to set active workspace: ${error?.message ?? String(error)}` }
    }
  },
}
