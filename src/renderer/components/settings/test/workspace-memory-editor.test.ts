import { expect, it, vi } from 'vitest'
import { createWorkspaceMemoryEditor } from '../workspaceMemoryEditor'
import type { AgentMemoryInvalidation, WorkspaceMemoryAPI } from '../../../../shared/types/agent-memory'
it('drops stale metadata and loads, filters notifications and preserves scoped drafts across switches', async () => {
  let active = 'a'
  const listeners = new Set<(event: AgentMemoryInvalidation) => void>()
  let resolveA!: (value: unknown) => void
  const api = {
    context: vi.fn(async () => ({ success: true, data: { workspaceId: active, name: active } })),
    read: vi.fn((id: string) => id === 'a' ? new Promise(resolve => { resolveA = resolve }) : Promise.resolve({ success: true, data: { content: 'B', revision: 'b' } })),
    readMaintenance: vi.fn(async () => ({ success: true, data: true })),
    save: vi.fn(async (_id, content) => ({ success: true, data: { content, revision: 'saved' } })),
  } as unknown as WorkspaceMemoryAPI
  const model = createWorkspaceMemoryEditor(api, listener => { listeners.add(listener); return () => { listeners.delete(listener) } })
  const a = model.switchWorkspace('a')
  await vi.waitFor(() => expect(api.read).toHaveBeenCalledWith('a'))
  active = 'b'; await model.switchWorkspace('b')
  resolveA({ success: true, data: { content: 'late A', revision: 'a' } }); await a
  expect(model.current?.editor.content).toBe('B')
  model.current!.editor.content = 'draft B'
  for (const listener of listeners) listener({ kind: 'workspace', workspaceId: 'a' })
  expect(model.current?.editor.content).toBe('draft B')
  active = 'a'; const backA = model.switchWorkspace('a')
  await vi.waitFor(() => expect(api.read).toHaveBeenCalledTimes(3))
  resolveA({ success: true, data: { content: 'A', revision: 'a' } }); await backA
  active = 'b'; await model.switchWorkspace('b')
  expect(model.current?.editor.content).toBe('draft B')
  await model.current!.editor.save()
  expect(api.save).toHaveBeenCalledWith('b', 'draft B', 'b')
  await model.switchWorkspace(null)
  expect(model.current).toBeNull()
  expect(listeners.size).toBe(0)
  model.dispose()
})
it('does not restore a cleared workspace draft or discard another workspace draft after a late cleanup', async () => {
  let active = 'a'
  let finish!: (value: unknown) => void
  const api = {
    context: async () => ({ success: true, data: { workspaceId: active, name: active } }),
    read: async (id: string) => ({ success: true, data: { content: id === 'a' ? '' : 'B', revision: id } }),
    readMaintenance: async () => ({ success: true, data: true }),
    cleanup: vi.fn(() => new Promise(resolve => { finish = resolve })),
  } as unknown as WorkspaceMemoryAPI
  const model = createWorkspaceMemoryEditor(api, () => () => {})
  await model.switchWorkspace('a')
  model.current!.editor.content = 'A draft to forget'
  const cleanup = model.current!.api.cleanup({ user: true, history: true, snapshots: true }, 'preview')
  active = 'b'; await model.switchWorkspace('b')
  model.current!.editor.content = 'B unsaved'
  finish({ success: true }); await cleanup
  expect(model.current!.editor.content).toBe('B unsaved')
  active = 'a'; await model.switchWorkspace('a')
  expect(model.current!.editor.content).toBe('')
  model.dispose()
})
