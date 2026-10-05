import { describe, expect, it, vi } from 'vitest'
import { createMemoryEditor } from '../memoryEditor'
import type { AgentMemoryInvalidation } from '../../../../shared/types/agent-memory'

function liveAPI() {
  let notify: (event: AgentMemoryInvalidation) => void = () => {}
  const stop = vi.fn()
  const api = {
    read: vi.fn().mockResolvedValue({ success: true, data: { content: 'original', revision: 'r1' } }), save: vi.fn(),
    onChanged: vi.fn((listener: typeof notify) => { notify = listener; return stop }),
  }
  return { api, stop, notify: (revision?: string) => notify({ kind: 'user', revision }) }
}
it('subscribes before loading, refreshes clean text and protects dirty text with a notice', async () => {
  const { api, stop, notify } = liveAPI()
  const editor = createMemoryEditor('user', api)
  await editor.start()
  expect(api.onChanged.mock.invocationCallOrder[0]).toBeLessThan(api.read.mock.invocationCallOrder[0])
  api.read.mockResolvedValue({ success: true, data: { content: 'external', revision: 'r2' } })
  notify('r2'); await editor.refresh()
  expect(editor.content).toBe('external')
  editor.content = 'draft'
  api.read.mockResolvedValue({ success: true, data: { content: 'newer', revision: 'r3' } })
  notify('r3'); await editor.refresh()
  expect(editor.content).toBe('draft')
  expect(editor.revision).toBe('r2')
  expect(editor.notice).toContain('其他')
  editor.dispose()
  expect(stop).toHaveBeenCalledOnce()
})

it('discards a stale read when another notification arrives and edits during refresh survive', async () => {
  const { api, notify } = liveAPI()
  const editor = createMemoryEditor('user', api)
  await editor.start()
  let release!: (value: unknown) => void
  api.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    .mockResolvedValue({ success: true, data: { content: 'latest', revision: 'r3' } })
  notify('r2')
  editor.content = 'typed while reading'
  notify('r3')
  release({ success: true, data: { content: 'obsolete', revision: 'r2' } })
  await editor.refresh()
  expect(editor.content).toBe('typed while reading')
  expect(editor.baseContent).toBe('original')
  expect(editor.notice).toContain('其他')
  await editor.load(true)
  expect(editor.content).toBe('latest')
  editor.dispose()
})

describe('memory settings editor', () => {
  it('re-reads an invalidation superseded by a failed save instead of leaving a clean stale editor', async () => {
    const { api, notify } = liveAPI()
    const editor = createMemoryEditor('user', api)
    await editor.start()
    let release!: (value: unknown) => void
    api.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      .mockResolvedValue({ success: true, data: { content: 'latest', revision: 'r2' } })
    notify('r2')
    api.save.mockResolvedValue({ success: false, error: '版本冲突' })
    const saving = editor.save()
    release({ success: true, data: { content: 'latest', revision: 'r2' } })
    await saving
    expect(editor.content).toBe('latest')
    expect(editor.error).toBe('版本冲突')
    editor.dispose()
  })
  it('does not lose a notification arriving as the read pump settles', async () => {
    const { api, notify } = liveAPI()
    const editor = createMemoryEditor('user', api)
    await editor.start()
    let release!: (value: unknown) => void
    api.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      .mockResolvedValue({ success: true, data: { content: 'latest', revision: 'r3' } })
    notify('r2')
    release({ success: true, data: { content: 'middle', revision: 'r2' } })
    queueMicrotask(() => notify('r3'))
    await editor.refresh()
    expect(editor.content).toBe('latest')
    editor.dispose()
  })
  it('coalesces initial-load invalidations and suppresses own save echoes without hiding later writes', async () => {
    const { api, notify } = liveAPI()
    let releaseRead!: (value: unknown) => void
    api.read.mockImplementationOnce(() => new Promise(resolve => { releaseRead = resolve }))
      .mockResolvedValue({ success: true, data: { content: 'new', revision: 'r2' } })
    const editor = createMemoryEditor('user', api)
    const loading = editor.start()
    notify('r2')
    releaseRead({ success: true, data: { content: 'old', revision: 'r1' } })
    await loading
    expect(editor.content).toBe('new')
    let releaseSave!: (value: unknown) => void
    api.save.mockImplementationOnce(() => new Promise(resolve => { releaseSave = resolve }))
    editor.content = 'ours'
    const saving = editor.save()
    api.read.mockResolvedValue({ success: true, data: { content: 'ours', revision: 'r3' } })
    notify('r3')
    releaseSave({ success: true, data: { content: 'ours', revision: 'r3' } })
    await saving
    expect(editor.notice).toContain('已保存')
    expect(editor.notice).not.toContain('其他')
    // The later external commit wins even if our older invoke response arrives last.
    api.save.mockImplementationOnce(() => new Promise(resolve => { releaseSave = resolve }))
    editor.content = 'ours again'
    const nextSave = editor.save()
    notify('r4')
    api.read.mockResolvedValue({ success: true, data: { content: 'external latest', revision: 'r5' } })
    notify('r5')
    releaseSave({ success: true, data: { content: 'ours again', revision: 'r4' } })
    await nextSave
    expect(editor.content).toBe('external latest')
    expect(editor.revision).toBe('r5')
    editor.dispose()
  })

  it('never applies a delayed refresh after save or dispose and preserves a newer local edit', async () => {
    const { api, notify } = liveAPI()
    const editor = createMemoryEditor('user', api)
    await editor.start()
    let releaseRead!: (value: unknown) => void
    api.read.mockImplementationOnce(() => new Promise(resolve => { releaseRead = resolve }))
    notify('r2')
    editor.content = 'ours'
    api.save.mockResolvedValue({ success: true, data: { content: 'ours', revision: 'r3' } })
    const saving = editor.save()
    editor.content = 'typed later'
    releaseRead({ success: true, data: { content: 'obsolete', revision: 'r2' } })
    await saving
    expect(editor.content).toBe('typed later')
    expect(editor.baseContent).toBe('ours')
    api.read.mockImplementationOnce(() => new Promise(resolve => { releaseRead = resolve }))
    notify('r4')
    const refreshing = editor.refresh()
    editor.dispose()
    releaseRead({ success: true, data: { content: 'unmounted', revision: 'r4' } })
    await refreshing
    expect(editor.content).toBe('typed later')
    expect(editor.revision).toBe('r3')
  })

  it('ignores a rejected initial read after unmount', async () => {
    const { api } = liveAPI()
    let reject!: (reason: Error) => void
    api.read.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const editor = createMemoryEditor('user', api)
    const loading = editor.start()
    editor.dispose()
    reject(new Error('late error'))
    await loading
    expect(editor.error).toBe('')
  })
  it('blocks writes until load succeeds, retains drafts on failure, saves revisions', async () => {
    const api = { read: vi.fn().mockResolvedValue({ success: false, error: '读取失败' }), save: vi.fn() }
    const editor = createMemoryEditor('soul', api)
    await editor.save()
    expect(api.save).not.toHaveBeenCalled()
    await editor.load()
    expect(editor.error).toBe('读取失败')
    expect(editor.ready).toBe(false)
    api.read.mockResolvedValue({ success: true, data: { content: '原文', revision: 'r1' } })
    await editor.load()
    editor.content = '修改'
    api.save.mockResolvedValue({ success: false, error: '版本冲突' })
    await editor.save()
    expect(editor.content).toBe('修改')
    expect(editor.error).toBe('版本冲突')
    api.save.mockResolvedValue({ success: true, data: { content: '修改', revision: 'r2' } })
    await editor.save()
    expect(api.save).toHaveBeenLastCalledWith('soul', '修改', 'r1')
    expect(editor.revision).toBe('r2')
    expect(editor.notice).toContain('已保存')
  })
})
