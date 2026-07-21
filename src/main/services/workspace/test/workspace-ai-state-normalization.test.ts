import { describe, expect, it } from 'vitest'
import { normalizeAiAssistantState } from '../workspaceAiService'

const createState = (argumentContent: string) => ({
  conversations: [{
    id: 'conversation-1',
    title: 'Agent 对话',
    createdAt: 1,
    updatedAt: 2,
    draft: '',
    messages: [{
      id: 2,
      role: 'assistant',
      text: '',
      createdAt: 2,
      mode: 'agent',
      timeline: [{
        id: 'step-1',
        title: '调用 file_read',
        status: 'completed',
        startedAt: 10,
        endedAt: 20,
        outputs: [{
          id: 'step-1-tool-arguments',
          type: 'json',
          title: '调用参数',
          content: argumentContent,
        }],
      }],
    }],
  }],
  activeConversationId: 'conversation-1',
})

describe('workspace AI state tool argument normalization', () => {
  it('redacts sensitive keys and bounds persisted tool arguments', () => {
    const state = normalizeAiAssistantState(createState(JSON.stringify({
      path: 'docs/guide.md',
      apiKey: 'never-save-this',
      nested: {
        authorization: 'Bearer never-save-this-either',
        query: 'x'.repeat(10_000),
      },
    })))

    const content = state.conversations[0].messages[0].timeline?.[0].outputs[0].content || ''
    expect(content).toContain('docs/guide.md')
    expect(content).toContain('[已脱敏]')
    expect(content).not.toContain('never-save-this')
    expect(content.length).toBeLessThanOrEqual(4_000)
  })

  it('rejects malformed persisted tool argument previews', () => {
    const state = normalizeAiAssistantState(createState('{"apiKey":"unterminated'))
    const content = state.conversations[0].messages[0].timeline?.[0].outputs[0].content
    expect(content).toBe('{}')
  })
})
