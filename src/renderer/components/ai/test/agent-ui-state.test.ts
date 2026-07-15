import { describe, expect, it } from 'vitest'
import type { AiAssistantMessage } from '@/renderer/stores/workspace'
import { deriveAgentUiState } from '../agentUiState'

const assistant = (overrides: Partial<AiAssistantMessage>): AiAssistantMessage => ({
  id: 1,
  role: 'assistant',
  text: 'answer',
  createdAt: 1,
  ...overrides,
})

const timeline = [
  {
    id: 'read',
    title: '读取文件',
    status: 'completed' as const,
    startedAt: 10,
    endedAt: 20,
    outputs: [
      { id: 'source-1', type: 'source' as const, path: 'docs/a.md', content: 'A' },
      { id: 'result-1', type: 'text' as const, content: '已读取' },
    ],
  },
  {
    id: 'search',
    title: '搜索工作区',
    status: 'active' as const,
    startedAt: 21,
    outputs: [
      { id: 'source-2', type: 'source' as const, path: 'docs/b.md', content: 'B' },
    ],
  },
]

describe('deriveAgentUiState', () => {
  it('默认提取当前最后一条带过程的 assistant 消息', () => {
    const messages: AiAssistantMessage[] = [
      { id: 1, role: 'user', text: 'question', createdAt: 1 },
      assistant({ id: 2, timeline, mode: 'agent', agentSummary: { status: 'running', toolCallCount: 2 } }),
      assistant({ id: 3, text: 'legacy answer' }),
    ]

    const state = deriveAgentUiState(messages)

    expect(state.messageId).toBe(2)
    expect(state.timeline).toBe(timeline)
    expect(state.sourceCount).toBe(2)
    expect(state.toolCallCount).toBe(2)
    expect(state.status).toBe('running')
    expect(state.statusLabel).toBe('运行中')
  })

  it('优先提取用户选中的 assistant 消息过程与持久化来源计数', () => {
    const selected = assistant({
      id: 4,
      timeline: timeline.slice(0, 1),
      mode: 'agent',
      agentSummary: { status: 'completed', toolCallCount: 3, sourceCount: 7 },
    })

    const state = deriveAgentUiState([selected, assistant({ id: 5, timeline })], 4)

    expect(state.message).toBe(selected)
    expect(state.timeline).toBe(selected.timeline)
    expect(state.sourceCount).toBe(7)
    expect(state.toolCallCount).toBe(3)
    expect(state.statusLabel).toBe('已完成')
  })

  it.each([
    ['completed', '已完成'],
    ['cancelled', '已取消'],
    ['error', '运行失败'],
  ] as const)('将 %s 映射为友好状态标签', (status, label) => {
    const state = deriveAgentUiState([
      assistant({ id: 8, mode: 'agent', timeline, agentSummary: { status } }),
    ])

    expect(state.status).toBe(status)
    expect(state.statusLabel).toBe(label)
  })

  it('只从持久化错误读取友好文案和技术详情', () => {
    const state = deriveAgentUiState([
      assistant({
        id: 9,
        mode: 'agent',
        timeline,
        agentSummary: {
          status: 'error',
          error: { message: '搜索暂时不可用，请稍后重试。', technicalDetail: 'workspace_search timeout' },
        },
      }),
    ])

    expect(state.errorMessage).toBe('搜索暂时不可用，请稍后重试。')
    expect(state.technicalDetail).toBe('workspace_search timeout')
  })

  it('历史消息没有模型身份时保持为空，不用当前设置回填', () => {
    const state = deriveAgentUiState(
      [assistant({ id: 10, mode: 'agent', timeline, aiName: '历史名称' })],
      10,
      { provider: 'openai', model: 'current-model', displayName: 'OpenAI · current-model' },
    )

    expect(state.modelIdentity).toBeUndefined()
  })

  it('选中非 assistant 或无过程消息时回退到最近的 assistant 过程', () => {
    const messages: AiAssistantMessage[] = [
      assistant({ id: 11, timeline, agentSummary: { status: 'completed' } }),
      { id: 12, role: 'user', text: 'next', createdAt: 12 },
      assistant({ id: 13, text: 'plain legacy answer' }),
    ]

    expect(deriveAgentUiState(messages, 12).messageId).toBe(11)
    expect(deriveAgentUiState(messages, 13).messageId).toBe(11)
  })
})
