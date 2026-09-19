import { expect, it, vi } from 'vitest'
import fs from 'node:fs'
import ts from 'typescript'

function fixture() {
  const source = fs.readFileSync(new URL('../TopBar.vue', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('const closeWindow ='), source.indexOf('let cleanupPrepareClose'))
  const workspace = { isWorkspaceTransitioning: false, setWorkspaceTransition: vi.fn(), ensureSavedBeforeWorkspaceChange: vi.fn().mockResolvedValue(true), saveWorkspaceMeta: vi.fn().mockResolvedValue(undefined) }
  const external = { closeAll: vi.fn().mockResolvedValue(true) }
  const api = { beginClose: vi.fn(), cancelClose: vi.fn(), close: vi.fn() }
  const close = new Function('workspaceStore', 'externalDocuments', 'window', ts.transpile(body) + '; return closeWindow')(workspace, external, { electronAPI: { window: api } })
  return { workspace, external, api, close }
}
it('cancels a window close when save preparation throws', async () => {
  const f = fixture()
  f.workspace.ensureSavedBeforeWorkspaceChange.mockRejectedValue(new Error('save failed'))
  await expect(f.close()).resolves.toBeUndefined()
  expect(f.api.cancelClose).toHaveBeenCalledOnce()
  expect(f.api.close).not.toHaveBeenCalled()
})
it('cancels a close requested during workspace transition', async () => {
  const f = fixture()
  f.workspace.isWorkspaceTransitioning = true
  await f.close()
  expect(f.api.cancelClose).toHaveBeenCalledOnce()
  expect(f.api.close).not.toHaveBeenCalled()
})
