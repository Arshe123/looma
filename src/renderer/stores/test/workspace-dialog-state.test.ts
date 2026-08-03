import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'

describe('workspace modal state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('keeps the command palette mutually exclusive with text input', async () => {
    const store = useWorkspaceStore()
    store.openCommandPalette('workspace')

    const result = store.requestTextInput('编辑标题', '旧标题')

    expect(store.commandPaletteOpen).toBe(false)
    expect(store.inputDialogOpen).toBe(true)
    store.openCommandPalette('should-not-open')
    expect(store.commandPaletteOpen).toBe(false)

    store.cancelTextInput()
    await expect(result).resolves.toBeNull()
    expect(store.inputDialogOpen).toBe(false)
  })

  it('cancels text input before opening confirmation and resets after acceptance', async () => {
    const store = useWorkspaceStore()
    const textResult = store.requestTextInput('编辑标题', '旧标题')
    const confirmationResult = store.requestConfirmation({
      title: '删除对话',
      message: '此操作不可恢复。',
      confirmText: '删除',
      danger: true,
    })

    await expect(textResult).resolves.toBeNull()
    expect(store.inputDialogOpen).toBe(false)
    expect(store.confirmationDialogOpen).toBe(true)
    expect(store.confirmationDialogConfirmText).toBe('删除')
    expect(store.confirmationDialogDanger).toBe(true)

    store.acceptConfirmation()
    await expect(confirmationResult).resolves.toBe(true)
    expect(store.confirmationDialogOpen).toBe(false)
    expect(store.confirmationDialogTitle).toBe('')
    expect(store.confirmationDialogConfirmText).toBe('确定')
    expect(store.confirmationDialogDanger).toBe(false)
  })

  it('resolves a superseded confirmation as cancelled', async () => {
    const store = useWorkspaceStore()
    const first = store.requestConfirmation({ title: '第一次', message: 'first' })
    const second = store.requestConfirmation({ title: '第二次', message: 'second' })

    await expect(first).resolves.toBe(false)
    expect(store.confirmationDialogTitle).toBe('第二次')

    store.cancelConfirmation()
    await expect(second).resolves.toBe(false)
  })

  it('keeps fullscreen dialogs self-dismissible and removes native confirm from history actions', () => {
    const inputDialog = readFileSync(resolve(process.cwd(), 'src/renderer/components/InputDialog.vue'), 'utf8')
    const confirmationDialog = readFileSync(resolve(process.cwd(), 'src/renderer/components/ConfirmationDialog.vue'), 'utf8')
    const historyPanel = readFileSync(resolve(process.cwd(), 'src/renderer/components/ai/AiConversationHistoryPanel.vue'), 'utf8')

    expect(inputDialog).toContain('@pointerdown.self="cancel"')
    expect(inputDialog).not.toContain('class="absolute inset-0')
    expect(inputDialog).toContain("window.addEventListener('keydown', handleWindowKeydown, { capture: true })")
    expect(confirmationDialog).toContain('@pointerdown.self="cancel"')
    expect(historyPanel).not.toContain('window.confirm(')
    expect(historyPanel).toContain('workspaceStore.requestConfirmation({')
  })
})
