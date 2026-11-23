import { describe, expect, it } from 'vitest'
import { flattenAgentHistoryForSummary, normalizeAgentConversationHistory, type AgentHistoryMessage } from '../agent-history'
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
  it('uses canonical tool content instead of the timeline summary', () => {
    const toolHistory: AgentHistoryMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'read', type: 'function', function: { name: 'file_read', arguments: { path: 'docs/config.md' } } }] },
      { role: 'tool', name: 'file_read', tool_call_id: 'read', content: '{"modelContext":{"structuredData":{"content":"真实文件正文"}}}' },
    ]
    expect(normalizeAgentConversationHistory([agentMessage], new Set(), new Map([[7, toolHistory]]))).toEqual([
      ...toolHistory, { role: 'assistant', content: agentMessage.text },
    ])
  })

  it('does not manufacture tool observations from UI-only summaries', () => {
    expect(normalizeAgentConversationHistory([agentMessage], new Set())).toEqual([
      { role: 'assistant', content: agentMessage.text },
    ])
  })

  it('discards incomplete canonical exchanges while preserving complete batches', () => {
    const calls: AgentHistoryMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'missing', type: 'function', function: { name: 'file_read', arguments: {} } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'ok', type: 'function', function: { name: 'file_read', arguments: {} } }] },
      { role: 'tool', content: '真实正文', name: 'file_read', tool_call_id: 'ok' },
    ]
    expect(normalizeAgentConversationHistory([agentMessage], new Set(), new Map([[7, calls]]))).toEqual([
      ...calls.slice(1), { role: 'assistant', content: agentMessage.text },
    ])
  })

  it('preserves parallel calls persisted as individual assistant messages before their results', () => {
    const calls: AgentHistoryMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'file_read', arguments: { path: 'a.md' } } }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'b', type: 'function', function: { name: 'file_read', arguments: { path: 'b.md' } } }] },
      { role: 'tool', content: 'A 正文', name: 'file_read', tool_call_id: 'a' },
      { role: 'tool', content: 'B 正文', name: 'file_read', tool_call_id: 'b' },
    ]
    expect(normalizeAgentConversationHistory([agentMessage], new Set(), new Map([[7, calls]]))).toEqual([
      calls[0], calls[2], calls[1], calls[3], { role: 'assistant', content: agentMessage.text },
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
    const history: AgentHistoryMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'read', type: 'function', function: { name: 'file_read', arguments: { path: 'docs/config.md' } } }] },
      { role: 'tool', content: '真实正文', name: 'file_read', tool_call_id: 'read' },
    ]
    const summaryHistory = flattenAgentHistoryForSummary(history)
    expect(summaryHistory.every(message => message.role !== 'tool')).toBe(true)
    expect(summaryHistory.map(message => message.content).join('\n')).toContain('工具 file_read 返回')
    expect(summaryHistory.map(message => message.content).join('\n')).toContain('docs/config.md')
  })
})
