import { describe, expect, it } from 'vitest'
import { flattenAgentHistoryForSummary, normalizeAgentConversationHistory } from '../agent-history'
import type { AiAssistantMessage } from '../workspace-types'

const agentMessage: AiAssistantMessage = {
  id: 7,
  role: 'assistant',
  text: '配置文件位于 docs/config.md。',
  createdAt: 100,
  mode: 'agent',
  timeline: [{
    id: 'step_1',
    title: '调用 file_read',
    status: 'completed',
    startedAt: 10,
    endedAt: 20,
    outputs: [
      { id: 'args', type: 'json', title: '调用参数', content: '{"path":"docs/config.md"}' },
      { id: 'result', type: 'text', title: '结果摘要', content: '已读取 docs/config.md，共 24 行。' },
    ],
  }],
}

describe('Agent conversation history', () => {
  it('adds complete provider-native tool call/result pairs before the final answer', () => {
    expect(normalizeAgentConversationHistory([agentMessage], new Set())).toEqual([
      {
        role: 'assistant',
        content: '此前调用了工具 file_read。',
        tool_calls: [{
          id: 'history_7_1',
          type: 'function',
          function: { name: 'file_read', arguments: { path: 'docs/config.md' } },
        }],
      },
      {
        role: 'tool',
        name: 'file_read',
        tool_call_id: 'history_7_1',
        content: '已读取 docs/config.md，共 24 行。',
      },
      { role: 'assistant', content: '配置文件位于 docs/config.md。' },
    ])
  })

  it('does not emit unmatched calls from interrupted history', () => {
    const interrupted = structuredClone(agentMessage)
    interrupted.timeline![0].outputs = interrupted.timeline![0].outputs.filter(output => output.title !== '结果摘要')
    expect(normalizeAgentConversationHistory([interrupted], new Set())).toEqual([
      { role: 'assistant', content: '配置文件位于 docs/config.md。' },
    ])
  })

  it('converts native tool messages to bounded textual input for distant summaries', () => {
    const history = normalizeAgentConversationHistory([agentMessage], new Set())
    const summaryHistory = flattenAgentHistoryForSummary(history)
    expect(summaryHistory.every(message => message.role !== 'tool')).toBe(true)
    expect(summaryHistory.map(message => message.content).join('\n')).toContain('工具 file_read 返回')
    expect(summaryHistory.map(message => message.content).join('\n')).toContain('docs/config.md')
  })
})
