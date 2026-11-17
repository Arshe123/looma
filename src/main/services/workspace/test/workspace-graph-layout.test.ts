import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { workspaceMetaService } from '../workspaceMetaService'

const workspace = vi.hoisted(() => ({ path: '' }))
vi.mock('../workspaceService', () => ({ workspaceService: { getState: async () => ({
  success: true, data: { workspaces: [{ id: 'graph', path: workspace.path }] },
}) } }))
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

it('round trips the graph panel through the actual metadata file', async () => {
  workspace.path = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-graph-layout-'))
  directories.push(workspace.path)
  const saved = await workspaceMetaService.setMeta('graph', {
    expandedDirs: [], selectedPaths: [], noteOrder: {}, activeSidebarPanel: 'graph',
    activeAuxiliaryPanel: 'graph', fileSidebarOpen: false,
  })
  expect(saved.success).toBe(true)
  expect((await workspaceMetaService.getMeta('graph')).data).toMatchObject({
    activeSidebarPanel: 'graph', activeAuxiliaryPanel: 'graph', fileSidebarOpen: false,
  })
})
