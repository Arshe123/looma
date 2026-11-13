import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { confirmMessageDialog, showMessageDialog, useMessageDialogStore } from '../message-dialog'

describe('shared message dialogs', () => {
  beforeEach(() => { setActivePinia(createPinia()) })

  it('queues requests without replacing an unanswered prompt and ignores stale responses', async () => {
    const store = useMessageDialogStore()
    const first = showMessageDialog({ type: 'warning', message: '保存？', buttons: ['保存', '不保存', '取消'], defaultId: 0, cancelId: 2 })
    const firstId = store.current!.id
    const second = showMessageDialog({ type: 'info', message: '完成' })
    expect(store.current!.options.message).toBe('保存？')
    expect(store.current!.options.defaultId).toBe(0)
    store.respond(firstId, 1)
    await expect(first).resolves.toEqual({ response: 1 })
    const secondId = store.current!.id
    expect(secondId).not.toBe(firstId)
    store.respond(firstId, 0)
    expect(store.current!.id).toBe(secondId)
    expect(store.current!.options.buttons).toEqual(['知道了'])
    store.respond(secondId, 0)
    await expect(second).resolves.toEqual({ response: 0 })
    expect(store.current).toBeNull()
  })

  it('defaults a destructive confirmation to cancel and maps the response to a boolean', async () => {
    const store = useMessageDialogStore()
    const confirmed = confirmMessageDialog({ title: '删除文件', message: '移入回收站？', confirmText: '删除', danger: true })
    expect(store.current!.options).toMatchObject({ type: 'warning', buttons: ['删除', '取消'], defaultId: 1, cancelId: 1, dangerId: 0 })
    store.respond(store.current!.id, 1)
    await expect(confirmed).resolves.toBe(false)
    const accepted = confirmMessageDialog({ title: '继续', message: '继续？' })
    store.respond(store.current!.id, 0)
    await expect(accepted).resolves.toBe(true)
  })

  it('settles all pending requests as cancelled when the host is removed', async () => {
    const store = useMessageDialogStore()
    const first = showMessageDialog({ message: '保存？', buttons: ['保存', '不保存', '取消'], cancelId: 2 })
    const second = confirmMessageDialog({ title: '删除', message: '删除？' })
    store.cancelAll()
    await expect(first).resolves.toEqual({ response: 2 })
    await expect(second).resolves.toBe(false)
    expect(store.current).toBeNull()
  })

  it('copies request options and ignores invalid button responses', async () => {
    const store = useMessageDialogStore()
    const buttons = ['继续', '取消']
    const result = showMessageDialog({ message: '继续？', buttons, defaultId: 99, cancelId: 99 })
    buttons[0] = '已改变'
    expect(store.current!.options).toMatchObject({ buttons: ['继续', '取消'], defaultId: 1, cancelId: 1 })
    store.respond(store.current!.id, -1)
    expect(store.current).not.toBeNull()
    store.cancelAll()
    await expect(result).resolves.toEqual({ response: 1 })
  })
})
