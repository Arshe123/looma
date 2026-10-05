import { expect, it, vi } from 'vitest'
import { createMemoryEditor } from '../memoryEditor'
import { createUserProfileHistory } from '../userProfileHistory'

it('browses without overwriting drafts, requires confirmation, restores with current CAS, retains drafts on errors', async () => {
  const version = { id: 'version', content: '<script>literal</script>', revision: 'old', source: 'manual' as const, createdAt: 1 }
  const api = {
    read: vi.fn().mockResolvedValue({ success: true, data: { content: 'current', revision: 'current' } }),
    save: vi.fn(),
    listUserHistory: vi.fn().mockResolvedValue({ success: true, data: { entries: [version] } }),
    readUserHistory: vi.fn().mockResolvedValue({ success: true, data: version }),
    restoreUserHistory: vi.fn().mockResolvedValue({ success: false, error: '版本冲突' }),
  }
  const editor = createMemoryEditor('user', api)
  await editor.load()
  editor.content = 'draft'
  const history = createUserProfileHistory(editor, api)
  await history.load()
  await history.select('version')
  expect(history.selected?.content).toBe(version.content)
  expect(editor.content).toBe('draft')
  await history.restore()
  expect(api.restoreUserHistory).not.toHaveBeenCalled()
  history.requestRestore()
  expect(history.error).toContain('未保存')
  expect(history.confirming).toBe(false)
  editor.content = 'current'
  history.requestRestore()
  expect(history.confirming).toBe(true)
  await history.restore()
  expect(api.restoreUserHistory).toHaveBeenCalledWith('version', 'current')
  expect(editor.content).toBe('current')
  expect(history.error).toBe('版本冲突')
  api.restoreUserHistory.mockResolvedValue({ success: true, data: version })
  history.requestRestore()
  await history.restore()
  expect(editor.content).toBe(version.content)
  expect(editor.revision).toBe('old')
  expect(editor.baseContent).toBe(version.content)
  expect(editor.notice).toContain('已恢复')
  expect(api.listUserHistory).toHaveBeenCalledTimes(2)
})

it('does not discard dirty content on a background/retry load and preserves it when explicit reload fails', async () => {
  const api = { read: vi.fn().mockResolvedValue({ success: true, data: { content: 'old', revision: 'r' } }), save: vi.fn() }
  const editor = createMemoryEditor('user', api)
  await editor.load()
  editor.content = 'draft'
  await editor.load()
  expect(editor.content).toBe('draft')
  expect(api.read).toHaveBeenCalledTimes(1)
  api.read.mockRejectedValue(new Error('读取失败'))
  await editor.load(true)
  expect(editor.content).toBe('draft')
  expect(editor.error).toBe('读取失败')
})

it('paginates and retains drafts on list/read/restore transport failures', async () => {
  const entry = { id: 'one', content: 'old', revision: 'old', createdAt: 1, source: 'agent' as const }
  const api = {
    read: vi.fn().mockResolvedValue({ success: true, data: { content: 'current', revision: 'current' } }), save: vi.fn(),
    listUserHistory: vi.fn().mockResolvedValue({ success: true, data: { entries: [entry], nextCursor: 'one' } }),
    readUserHistory: vi.fn().mockResolvedValue({ success: true, data: entry }),
    restoreUserHistory: vi.fn().mockRejectedValue(new Error('恢复失败')),
  }
  const editor = createMemoryEditor('user', api)
  await editor.load()
  const history = createUserProfileHistory(editor, api)
  await history.load()
  api.listUserHistory.mockResolvedValue({ success: true, data: { entries: [{ ...entry, id: 'two' }] } })
  await history.load(true)
  expect(api.listUserHistory).toHaveBeenLastCalledWith('one')
  expect(history.entries.map(item => item.id)).toEqual(['one', 'two'])
  await history.select('one')
  history.requestRestore()
  await history.restore()
  expect(history.error).toBe('恢复失败')
  expect(history.selected?.id).toBe('one')
  expect(editor.content).toBe('current')
  expect(editor.revision).toBe('current')
  editor.content = 'draft'
  api.listUserHistory.mockRejectedValue(new Error('历史读取失败'))
  await history.load()
  expect(history.entries).toHaveLength(2)
  expect(history.error).toBe('历史读取失败')
  api.readUserHistory.mockRejectedValue(new Error('版本损坏'))
  await history.select('two')
  expect(history.selected).toBeNull()
  expect(history.error).toBe('版本损坏')
  expect(editor.content).toBe('draft')
  expect(editor.busy).toBe(false)
})
