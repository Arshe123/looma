import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../types/agent-message'
import { assertAgentMessageTranscript, validateAgentMessageTranscript } from '../agent-message-invariants'

const messages: AgentMessage[] = [
  { id: 'msg_1', conversationId: 'chat_1', role: 'user', content: '读取配置', createdAt: 1 },
  {
    id: 'msg_2', conversationId: 'chat_1', taskId: 'task_1', runId: 'run_1', role: 'assistant', content: null, createdAt: 2,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'file_read', arguments: { path: 'docs/config.md' } } }],
  },
  { id: 'msg_3', conversationId: 'chat_1', taskId: 'task_1', runId: 'run_1', role: 'tool', name: 'file_read', tool_call_id: 'call_1', content: '{"facts":["读取成功"],"structuredData":{"path":"docs/config.md"}}', createdAt: 3 },
  { id: 'msg_4', conversationId: 'chat_1', taskId: 'task_1', runId: 'run_1', role: 'assistant', content: '配置文件已读取。', createdAt: 4 },
]

describe('Agent message invariants', () => {
  it('accepts a canonical assistant tool-call and tool-result pair', () => {
    expect(validateAgentMessageTranscript(messages)).toEqual([])
    expect(() => assertAgentMessageTranscript(messages)).not.toThrow()
  })

  it('rejects unmatched and mismatched tool results', () => {
    expect(validateAgentMessageTranscript([messages[0], { ...messages[2], tool_call_id: 'missing' }])).toEqual([
      { code: 'unmatched_tool_result', messageId: 'msg_3', callId: 'missing' },
    ])
    expect(validateAgentMessageTranscript([messages[1], { ...messages[2], name: 'workspace_search' }])).toEqual([
      { code: 'tool_name_mismatch', messageId: 'msg_3', callId: 'call_1' },
      { code: 'unmatched_tool_call', messageId: 'msg_2', callId: 'call_1' },
    ])
  })

  it('does not require thought summaries or timeline data in messages', () => {
    expect(JSON.stringify(messages)).not.toContain('thought_summary')
    expect(JSON.stringify(messages)).not.toContain('timeline')
  })
})
