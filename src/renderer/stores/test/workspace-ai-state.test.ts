import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'

const installElectronApiStub = () => {
  ;(globalThis as any).window = globalThis.window || globalThis
  ;(globalThis as any).window.electronAPI = {
    workspaceAi: {
      set: vi.fn().mockResolvedValue({ success: true }),
    },
  }
}

describe('workspace ai assistant temporary conversation state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installElectronApiStub()
  })

  it('does not create persisted conversations when starting temporary chats repeatedly', () => {
    const store = useWorkspaceStore()
    const originalCount = store.aiAssistant.conversations.length

    store.startTemporaryAiAssistantConversation()
    store.startTemporaryAiAssistantConversation()
    store.startTemporaryAiAssistantConversation()

    expect(store.aiAssistant.isTemporaryConversation).toBe(true)
    expect(store.aiAssistant.activeConversationId).toBeNull()
    expect(store.aiAssistant.conversations).toHaveLength(originalCount)
  })

  it('stores drafts in temporary state without touching existing conversation drafts', () => {
    const store = useWorkspaceStore()
    const existingId = store.aiAssistant.conversations[0].id

    store.startTemporaryAiAssistantConversation()
    store.setAiAssistantDraft('临时问题')

    expect(store.aiAssistant.temporaryDraft).toBe('临时问题')
    expect(store.aiAssistant.activeConversationId).toBeNull()
    expect(store.aiAssistant.conversations[0].id).toBe(existingId)
    expect(store.aiAssistant.conversations[0].draft).toBe('')
  })

  it('materializes a real conversation only when the first message is appended', () => {
    const store = useWorkspaceStore()
    const originalCount = store.aiAssistant.conversations.length

    store.startTemporaryAiAssistantConversation()
    store.setAiAssistantDraft('第一条问题')
    const messageId = store.appendAiAssistantMessage('user', '第一条问题')

    expect(messageId).toBeTypeOf('number')
    expect(store.aiAssistant.isTemporaryConversation).toBe(false)
    expect(store.aiAssistant.activeConversationId).toBe(store.aiAssistant.conversations[0].id)
    expect(store.aiAssistant.conversations).toHaveLength(originalCount + 1)
    expect(store.aiAssistant.conversations[0].title).toBe('第一条问题')
    expect(store.aiAssistant.conversations[0].messages[0]).toMatchObject({ role: 'user', text: '第一条问题' })
  })
})
