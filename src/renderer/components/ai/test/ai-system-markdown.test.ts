import { describe, expect, it, vi } from 'vitest'
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
        { id: 1, role: 'user', text: '**用户原文**', createdAt: 1 },
        { id: 2, role: 'assistant', text: '**回答**', createdAt: 2 },
        { id: 3, role: 'system', text: '## 系统标题\n\n**提示**与 `代码`\n\n- 检查设置\n- 重试\n\n<script>恶意</script>', createdAt: 3 },
        {
          id: 4, role: 'system', text: '**索引提示**', createdAt: 4,
          actions: [{ type: 'build-index', title: '建立索引', description: '索引说明', buttonText: '开始建立索引' }],
        },
      ],
    },
  }),
}))
vi.mock('@/renderer/stores/settings', () => ({
  useSettingsStore: () => ({ aiSettings: { chat: { provider: 'ollama', model: 'test' } } }),
}))
vi.mock('@/renderer/stores/ai-assistant', () => ({
  useAiAssistantStore: () => ({
    contextUsageByConversationId: {},
    isConversationRunningAgent: () => false,
    isWorkspaceIndexing: () => false,
    isBuildIndexDisabled: () => false,
    getConversationAgentRun: () => null,
    getMessageAgentDisplayEvents: () => [],
    getMessageMemoryUpdates: () => [],
  }),
}))
vi.mock('../AgentConversationFlow.vue', () => ({ default: { render: () => null } }))
vi.mock('../AgentFileReviewFloat.vue', () => ({ default: { render: () => null } }))
vi.mock('../AgentRagSources.vue', () => ({ default: { render: () => null } }))

const getMessageHtml = (html: string, id: number) => html.split(`data-chat-message-id="${id}"`)[1]?.split('data-chat-message-id=')[0] || ''

describe('系统消息 Markdown', () => {
  it('使用真实 Markdown 渲染系统正文和索引提示，保留用户原文与索引操作', async () => {
    const html = await renderToString(createSSRApp(AiAssistant))
    const system = getMessageHtml(html, 3)
    expect(system).toContain('<h2>系统标题</h2>')
    expect(system).toContain('<strong>提示</strong>')
    expect(system).toContain('<code>代码</code>')
    expect(system).toContain('<li>检查设置</li>')
    expect(system).not.toContain('<script>')
    expect(system).not.toContain('whitespace-pre-wrap')
    expect(system).toContain('系统事件')

    const index = getMessageHtml(html, 4)
    expect(index).toContain('<strong>索引提示</strong>')
    expect(index).toContain('当前工作空间还没有索引')
    expect(index).toContain('开始建立索引')
    expect(index).not.toContain('whitespace-pre-wrap')

    const user = getMessageHtml(html, 1)
    expect(user).toContain('**用户原文**')
    expect(user).toContain('whitespace-pre-wrap')
    expect(user).not.toContain('ai-markdown')
    expect(getMessageHtml(html, 2)).toContain('<strong>回答</strong>')
  })
})
