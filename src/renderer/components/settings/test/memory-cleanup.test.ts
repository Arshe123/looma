import { expect, it, vi } from 'vitest'
import { createMemoryCleanup } from '../memoryCleanup'

it('requires a current preview and explicit confirmation, invalidates changed scope, and reports partial failures honestly', async () => {
  const selection = { history: true, snapshots: false, user: false }
  const preview = { selection, token: 'main-token', records: ['user-history/id.json'], skipped: [], counts: { history: 1, snapshots: 0, user: 0, receipts: 0 } }
  const api = { previewCleanup: vi.fn().mockResolvedValue({ success: true, data: preview }), cleanup: vi.fn().mockResolvedValue({ success: false, error: '清理未完成，可能已有部分记录删除。' }) }
  const cleared = vi.fn()
  const state = createMemoryCleanup(api, cleared)
  await state.apply()
  expect(api.cleanup).not.toHaveBeenCalled()
  await state.inspect()
  expect(state.preview?.counts.history).toBe(1)
  await state.apply()
  expect(api.cleanup).not.toHaveBeenCalled()
  state.confirmed = true
  state.selection.snapshots = true
  expect(state.preview).toBe(null)
  expect(state.confirmed).toBe(false)
  await state.inspect()
  state.confirmed = true
  await state.apply()
  expect(api.cleanup).toHaveBeenCalledWith(selection, 'main-token')
  expect(state.error).toContain('未完成')
  expect(state.preview).toBe(null)
  expect(cleared).not.toHaveBeenCalled()
  api.cleanup.mockResolvedValue({ success: true } as never)
  await state.inspect(); state.confirmed = true; await state.apply()
  expect(cleared).toHaveBeenCalledWith(selection)
  expect(state.notice).toContain('旧聊天')
  state.dispose()
})
it('selecting current profile clearing includes history and snapshots but never modifies authorization', () => {
  const state = createMemoryCleanup({ previewCleanup: vi.fn(), cleanup: vi.fn() }, vi.fn())
  state.selection.user = true
  expect(state.selection).toEqual({ user: true, snapshots: true, history: true })
  state.dispose()
})
