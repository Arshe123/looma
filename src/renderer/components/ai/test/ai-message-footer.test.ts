import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import AiAssistant from '../AiAssistant.vue'

vi.mock('@/renderer/stores/workspace', () => ({
  useWorkspaceStore: () => ({
    activeWorkspaceId: 'workspace',
    aiAssistant: { activeConversationId: 'conversation' },
    activeAiAssistantConversation: {
      title: '测试对话', draft: '',
      messages: [
        { id: 1, role: 'user', text: '用户问题', createdAt: new Date('2026-09-29T13:51:00').getTime() },
        { id: 2, role: 'assistant', text: 'Agent 回答', createdAt: new Date('2026-09-28T13:52:00').getTime() },
        { id: 3, role: 'system', text: '系统提示', createdAt: new Date('2026-09-27T13:53:00').getTime() },
      ],
    },
  }),
}))
vi.mock('@/renderer/stores/settings', () => ({
  useSettingsStore: () => ({ aiSettings: { chat: { provider: 'ollama', model: 'test' } } }),
}))
vi.mock('@/renderer/stores/ai-assistant', () => ({
  useAiAssistantStore: () => ({
    isConversationRunningAgent: () => false,
    isWorkspaceIndexing: () => false,
    isBuildIndexDisabled: () => false,
    getConversationAgentRun: () => null,
    getMessageAgentDisplayEvents: () => [],
    getMessageMemoryUpdates: () => [{ id: 'receipt-1', changes: [{ type: 'added', text: '<script>恶意</script>\n偏好中文' }, { type: 'removed', text: '旧偏好' }] }],
  }),
}))
vi.mock('../AgentConversationFlow.vue', () => ({ default: { render: () => null } }))
vi.mock('../AgentFileReviewFloat.vue', () => ({ default: { render: () => null } }))
vi.mock('../AgentRagSources.vue', () => ({ default: { render: () => null } }))
vi.mock('../AiMarkdown.vue', () => ({ default: { render: () => null } }))

afterEach(() => { vi.useRealTimers() })

describe('聊天消息底栏', () => {
  it('adds one collapsed accessible memory notice outside the answer with safely escaped changes', async () => {
    const html = await renderToString(createSSRApp(AiAssistant))
    expect(html.match(/记忆已更新/g)).toHaveLength(1)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-controls="memory-changes-2-legacy-"')
    expect(html).toContain('lucide-brain')
    expect(html).toContain('偏好中文')
    expect(html).not.toContain('旧偏好')
    expect(html).not.toContain('新增')
    expect(html).not.toContain('移除')
    expect(html).toContain('&lt;script&gt;恶意&lt;/script&gt;')
    expect(html).not.toContain('<script>恶意</script>')
  })
  it('在气泡外为每条消息显示格式化时间，用户复制靠右，Agent 复制靠左，底栏仅悬停可见', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-29T18:00:00'))
    const html = await renderToString(createSSRApp(AiAssistant))
    const footers = [...html.matchAll(/<div class="([^"]*message-footer[^"]*)">([\s\S]*?)<\/div>/g)]
    expect(footers).toHaveLength(3)
    for (const footer of footers) {
      expect(footer[1]).toContain('invisible')
      expect(footer[1]).toContain('group-hover/message:visible')
      expect(footer[1]).not.toContain('bg-accent')
    }
    expect(footers[0][1]).toContain('justify-end')
    expect(footers[0][2]).toContain('13:51')
    expect(footers[0][2]).toContain('复制')
    expect(footers[1][1]).toContain('justify-start')
    expect(footers[1][2]).toContain('昨天 13:52')
    expect(footers[1][2]).toContain('复制')
    expect(footers[2][2]).toContain('前天 13:53')
    expect(footers[2][2]).not.toContain('<button')
    expect(html.match(/class="group\/message flex /g)).toHaveLength(3)
  })
})
