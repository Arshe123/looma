import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { useAiAssistantStore } from '../ai-assistant'
import { useWorkspaceStore } from '../workspace'

const deferred = () => {
  let resolve!: (value: any) => void
  const promise = new Promise<any>(done => { resolve = done })
  return { promise, resolve }
}

describe('workspace index availability', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as any).window = globalThis.window || globalThis
    window.electronAPI = { rag: { status: vi.fn() } } as any
  })

  it('wires historical action buttons to runtime availability, never persisted disabled flags', () => {
    const source = readFileSync(new URL('../../components/ai/AiAssistant.vue', import.meta.url), 'utf8')
    expect(source).not.toMatch(/checkedHasIndex|isCheckingIndex|action\.disabled|setBuildIndexActionsDisabled/)
    expect(source).toContain('aiAssistStore.isBuildIndexDisabled(workspaceStore.activeWorkspaceId)')
    expect(source).toContain(':disabled="isActionDisabled(action)"')
    expect(source).toContain('if (!workspaceId || isBuildIndexDisabled.value) return')
  })

  it('does not let a pending status check overwrite a newer index result', async () => {
    const store = useAiAssistantStore()
    const check = deferred()
    vi.mocked(window.electronAPI.rag.status).mockReturnValue(check.promise)
    const pending = store.refreshWorkspaceIndexStatus('a')
    store.setWorkspaceIndexResult('a', { exists: true, documentCount: 4 })
    check.resolve({ success: true, data: { exists: false } })
    await pending
    expect(store.getWorkspaceIndexResult('a')).toEqual({ exists: true, documentCount: 4 })
  })

  it('isolates overlapping checks across workspace switches and revisits', async () => {
    const store = useAiAssistantStore()
    const a1 = deferred()
    const b = deferred()
    const a2 = deferred()
    vi.mocked(window.electronAPI.rag.status)
      .mockReturnValueOnce(a1.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(a2.promise)
    const firstA = store.refreshWorkspaceIndexStatus('a')
    const pendingB = store.refreshWorkspaceIndexStatus('b')
    const secondA = store.refreshWorkspaceIndexStatus('a')
    a1.resolve({ success: true, data: { exists: true } })
    await firstA
    expect(store.getWorkspaceIndexResult('a')).toBeNull()
    expect(store.isBuildIndexDisabled('a')).toBe(true)
    expect(store.isBuildIndexDisabled('b')).toBe(true)
    a2.resolve({ success: true, data: { exists: false } })
    await secondA
    expect(store.isBuildIndexDisabled('a')).toBe(false)
    expect(store.isBuildIndexDisabled('b')).toBe(true)
    b.resolve({ success: true, data: { exists: true } })
    await pendingB
    expect(store.isBuildIndexDisabled('a')).toBe(false)
    expect(store.isBuildIndexDisabled('b')).toBe(true)
  })

  it('reports status failures, clears checking and preserves the last confirmed result', async () => {
    const store = useAiAssistantStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.mocked(window.electronAPI.rag.status).mockResolvedValueOnce({ success: false, error: 'offline' })
      await store.refreshWorkspaceIndexStatus('a')
      expect(warn).toHaveBeenCalledWith('offline')
      expect(store.isBuildIndexDisabled('a')).toBe(false)
      store.setWorkspaceIndexResult('a', { exists: true, documentCount: 2 })
      vi.mocked(window.electronAPI.rag.status).mockRejectedValueOnce(new Error('network'))
      await store.refreshWorkspaceIndexStatus('a')
      expect(warn).toHaveBeenCalledWith('检查索引状态失败。', expect.any(Error))
      expect(store.indexStatusRequestIdsByWorkspaceId.a).toBeUndefined()
      expect(store.getWorkspaceIndexResult('a')).toEqual({ exists: true, documentCount: 2 })
    } finally {
      warn.mockRestore()
    }
  })

  it.each(['done', 'empty', 'error'] as const)('derives button state after a stream ends: %s', async outcome => {
    const store = useAiAssistantStore()
    const workspace = useWorkspaceStore()
    const updateText = vi.spyOn(workspace, 'updateAiAssistantMessageTextInConversation')
    store.indexStreamsByWorkspaceId.a = {
      requestId: 'stream', workspaceId: 'a', conversationId: 'chat', messageId: 1,
      timeline: [], status: 'streaming', startedAt: 1,
    }
    store.indexRequestIdToWorkspaceId.stream = 'a'
    expect(store.isBuildIndexDisabled('a')).toBe(true)
    store.handleIndexStreamEvent(outcome === 'error'
      ? { requestId: 'stream', type: 'error', error: '建立索引失败。' }
      : { requestId: 'stream', type: 'done', exists: true, document_count: outcome === 'empty' ? 0 : 2 })
    expect(store.isWorkspaceIndexing('a')).toBe(false)
    expect(store.isBuildIndexDisabled('a')).toBe(outcome === 'done')
    if (outcome === 'error') expect(updateText).toHaveBeenCalledWith('chat', 1, expect.stringContaining('建立索引失败'))
  })

  it('does not save conversation history during status checks', async () => {
    const workspace = useWorkspaceStore()
    const save = vi.spyOn(workspace, 'saveAiAssistantState')
    vi.mocked(window.electronAPI.rag.status).mockResolvedValue({ success: true, data: { exists: true } } as any)
    await useAiAssistantStore().refreshWorkspaceIndexStatus('a')
    expect(save).not.toHaveBeenCalled()
  })

  it('derives availability from workspace selection, checking, result and streaming', async () => {
    const store = useAiAssistantStore()
    const check = deferred()
    vi.mocked(window.electronAPI.rag.status).mockReturnValue(check.promise)
    expect(store.isBuildIndexDisabled(null)).toBe(true)
    expect(store.isBuildIndexDisabled('a')).toBe(false)
    const pending = store.refreshWorkspaceIndexStatus('a')
    expect(store.isBuildIndexDisabled('a')).toBe(true)
    expect(store.isBuildIndexDisabled('b')).toBe(false)
    check.resolve({ success: true, data: { exists: false } })
    await pending
    expect(store.isBuildIndexDisabled('a')).toBe(false)
    store.indexStreamsByWorkspaceId.a = { requestId: 'stream' } as any
    expect(store.isBuildIndexDisabled('a')).toBe(true)
    delete store.indexStreamsByWorkspaceId.a
    store.setWorkspaceIndexResult('a', { exists: true, documentCount: 1 })
    expect(store.isBuildIndexDisabled('a')).toBe(true)
  })
})
