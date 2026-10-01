import { describe, expect, it, vi } from 'vitest'
import { createMemoryEditor } from '../memoryEditor'

describe('memory settings editor', () => {
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
