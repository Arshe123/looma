import { expect, it, vi } from 'vitest'
import { createMemoryEditor } from '../memoryEditor'
import { createUserProfileHistory } from '../userProfileHistory'

it('blocks damaged selections and skips them for previous-version restore while allowing healthy selection', async () => {
  const valid = { id: 'healthy', createdAt: 1, source: 'manual' as const, revision: 'old', content: 'safe', status: 'valid' as const }
  const invalid = { id: 'broken', createdAt: 2, status: 'invalid' as const, error: '历史版本缺失或已损坏，无法查看或恢复。' }
  const api = {
    read: vi.fn().mockResolvedValue({ success: true, data: { content: 'current', revision: 'current' } }), save: vi.fn(),
    listUserHistory: vi.fn().mockResolvedValue({ success: true, data: { entries: [invalid, valid] } }),
    readUserHistory: vi.fn().mockResolvedValue({ success: true, data: valid }),
    restoreUserHistory: vi.fn().mockResolvedValue({ success: true, data: valid }),
  }
  const editor = createMemoryEditor('user', api)
  await editor.load()
  const history = createUserProfileHistory(editor, api)
  await history.load()
  expect(history.previous?.id).toBe('healthy')
  await history.select('broken'); history.requestRestore(); await history.restore()
  expect(history.selected).toBeNull()
  expect(history.error).toContain('无法查看或恢复')
  expect(api.readUserHistory).not.toHaveBeenCalled()
  expect(api.restoreUserHistory).not.toHaveBeenCalled()
  await history.select('healthy'); history.requestRestore(); await history.restore()
  expect(api.restoreUserHistory).toHaveBeenCalledWith('healthy', 'current')
  expect(editor.content).toBe('safe')
  history.dispose()
})

it('clears a selected preview and confirmation when a refresh identifies its file as damaged', async () => {
  const valid = { id: 'old', createdAt: 1, source: 'manual' as const, status: 'valid' as const, revision: 'old', content: 'old' }
  const api = {
    read: vi.fn().mockResolvedValue({ success: true, data: { content: 'current', revision: 'current' } }), save: vi.fn(),
    listUserHistory: vi.fn().mockResolvedValue({ success: true, data: { entries: [valid] } }),
    readUserHistory: vi.fn().mockResolvedValue({ success: true, data: valid }), restoreUserHistory: vi.fn(),
  }
  const editor = createMemoryEditor('user', api)
  await editor.load()
  const history = createUserProfileHistory(editor, api)
  await history.load(); await history.select('old'); history.requestRestore()
  api.listUserHistory.mockResolvedValue({ success: true, data: { entries: [{ id: 'old', createdAt: 1, status: 'invalid', error: '历史版本缺失或已损坏，无法查看或恢复。' }] } })
  await history.load()
  expect(history.selected).toBeNull()
  expect(history.confirming).toBe(false)
  history.requestRestore(); await history.restore()
  expect(api.restoreUserHistory).not.toHaveBeenCalled()
  history.dispose()
})

it('drains history invalidations after a rejected restore without losing selection or the conflict', async () => {
  const version = { id: 'old', content: 'old', revision: 'r0', source: 'manual' as const, status: 'valid' as const, createdAt: 1 }
  let release!: (value: unknown) => void
  const api = {
    read: vi.fn().mockResolvedValue({ success: true, data: { content: 'current', revision: 'r1' } }), save: vi.fn(),
    listUserHistory: vi.fn().mockResolvedValue({ success: true, data: { entries: [version] } }),
    readUserHistory: vi.fn().mockResolvedValue({ success: true, data: version }),
    restoreUserHistory: vi.fn(() => new Promise<any>(resolve => { release = resolve })),
  }
  const editor = createMemoryEditor('user', api)
  await editor.load()
  const history = createUserProfileHistory(editor, api)
  await history.load(); await history.select('old'); history.requestRestore()
  const restoring = history.restore()
  editor.invalidation++
  api.listUserHistory.mockResolvedValue({ success: true, data: { entries: [{ ...version, id: 'new' }, version] } })
  release({ success: false, error: '版本冲突' })
  await restoring
  expect(history.entries.map(entry => entry.id)).toEqual(['new', 'old'])
  expect(history.selected?.id).toBe('old')
  expect(history.error).toBe('版本冲突')
  expect(history.confirming).toBe(false)
  expect(editor.content).toBe('current')
  history.dispose()
})

it('retries a stale history list response and retains an already selected immutable version', async () => {
  const version = { id: 'old', content: 'old', revision: 'r0', source: 'manual' as const, status: 'valid' as const, createdAt: 1 }
  const api = {
    read: vi.fn().mockResolvedValue({ success: true, data: { content: 'current', revision: 'r1' } }), save: vi.fn(),
    listUserHistory: vi.fn().mockResolvedValue({ success: true, data: { entries: [version] } }),
    readUserHistory: vi.fn().mockResolvedValue({ success: true, data: version }), restoreUserHistory: vi.fn(),
  }
  const editor = createMemoryEditor('user', api)
  await editor.load()
  const history = createUserProfileHistory(editor, api)
  await history.load(); await history.select('old')
  let release!: (value: unknown) => void
  api.listUserHistory.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    .mockResolvedValue({ success: true, data: { entries: [{ ...version, id: 'latest' }, version] } })
  const loading = history.load()
  editor.invalidation++
  release({ success: true, data: { entries: [] } })
  await loading
  expect(history.entries.map(entry => entry.id)).toEqual(['latest', 'old'])
  expect(history.selected?.id).toBe('old')
  history.dispose()
})

it('invalidates restore confirmation and refreshes history without dropping selection or drafts', async () => {
  const version = { id: 'old', content: 'old', revision: 'r0', source: 'manual' as const, status: 'valid' as const, createdAt: 1 }
  const api = {
    read: vi.fn().mockResolvedValue({ success: true, data: { content: 'current', revision: 'r1' } }), save: vi.fn(),
    listUserHistory: vi.fn().mockResolvedValue({ success: true, data: { entries: [version] } }),
    readUserHistory: vi.fn().mockResolvedValue({ success: true, data: version }), restoreUserHistory: vi.fn(),
  }
  const editor = createMemoryEditor('user', api)
  await editor.load()
  const history = createUserProfileHistory(editor, api)
  await history.load(); await history.select('old'); history.requestRestore()
  expect(history.confirming).toBe(true)
  editor.content = 'draft'
  editor.invalidation++
  expect(history.confirming).toBe(false)
  await history.load()
  expect(history.selected?.id).toBe('old')
  expect(editor.content).toBe('draft')
  await history.restore()
  expect(api.restoreUserHistory).not.toHaveBeenCalled()
  history.dispose()
})

it('browses without overwriting drafts, requires confirmation, restores with current CAS, retains drafts on errors', async () => {
  const version = { id: 'version', content: '<script>literal</script>', revision: 'old', source: 'manual' as const, status: 'valid' as const, createdAt: 1 }
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
  const entry = { id: 'one', content: 'old', revision: 'old', createdAt: 1, source: 'agent' as const, status: 'valid' as const }
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
