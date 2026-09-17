import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'

beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => { vi.unstubAllGlobals() })

describe('AI state loading safety', () => {
  it('preserves in-memory history and blocks writes after a failed load', async () => {
    const store = useWorkspaceStore()
    store.activeWorkspaceId = 'ws'
    store.aiAssistant.conversations[0].draft = 'retained'
    const get = vi.fn().mockResolvedValue({ success: false, error: '读取失败' })
    const set = vi.fn()
    const setDraft = vi.fn()
    vi.stubGlobal('window', { electronAPI: { workspaceAi: { get, set, setDraft } } })
    await store.loadAiAssistantState('ws')
    store.setAiAssistantDraft('replacement')
    store.saveAiAssistantState()
    expect(store.activeAiAssistantConversation.draft).toBe('retained')
    expect(store.isAiAssistantStateBlocked).toBe(true)
    expect(store.lastError).toBe('读取失败')
    expect(set).not.toHaveBeenCalled()
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('does not publish a stale response when revisiting the same workspace', async () => {
    const store = useWorkspaceStore()
    store.activeWorkspaceId = 'ws'
    const old = JSON.parse(JSON.stringify(store.aiAssistant))
    old.conversations[0].draft = 'old'
    const current = JSON.parse(JSON.stringify(old))
    current.conversations[0].draft = 'current'
    const resolvers: ((value: unknown) => void)[] = []
    const get = vi.fn(() => new Promise(r => { resolvers.push(r) }))
    vi.stubGlobal('window', { electronAPI: { workspaceAi: { get } } })
    const first = store.loadAiAssistantState('ws')
    const second = store.loadAiAssistantState('ws')
    resolvers[1]({ success: true, data: current })
    await second
    resolvers[0]({ success: true, data: old })
    await first
    expect(store.activeAiAssistantConversation.draft).toBe('current')
    expect(store.aiAssistantLoadStatus).toBe('ready')
  })

  it('blocks draft and checkpoint writes until the loaded conversation is available', async () => {
    const store = useWorkspaceStore()
    store.activeWorkspaceId = 'ws'
    const loaded = JSON.parse(JSON.stringify(store.aiAssistant))
    loaded.conversations[0].draft = 'saved'
    let resolve!: (value: unknown) => void
    const get = vi.fn(() => new Promise(r => { resolve = r }))
    const set = vi.fn().mockResolvedValue({ success: true })
    const setDraft = vi.fn().mockResolvedValue({ success: true })
    vi.stubGlobal('window', { electronAPI: { workspaceAi: { get, set, setDraft } } })
    const pending = store.loadAiAssistantState('ws')
    store.setAiAssistantDraft('unloaded')
    store.saveAiAssistantState()
    expect(setDraft).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    resolve({ success: true, data: loaded })
    await pending
    expect(store.activeAiAssistantConversation.draft).toBe('saved')
    store.setAiAssistantDraft('ready')
    expect(setDraft).toHaveBeenCalledWith('ws', loaded.activeConversationId, 'ready')
  })
})
