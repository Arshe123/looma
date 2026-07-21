import { describe, expect, it } from 'vitest'
import type { AiAssistantMessage } from '@/renderer/stores/workspace'
import { formatAgentRagSourceScore, getAgentRagSources } from '../agentRagSources'

const createMessage = (outputs: NonNullable<AiAssistantMessage['timeline']>[number]['outputs']): AiAssistantMessage => ({
  id: 1,
  role: 'assistant',
  text: '回答',
  createdAt: 1,
  mode: 'agent',
  timeline: [{
    id: 'agent-sources',
    title: '引用来源',
    status: 'completed',
    startedAt: 1,
    endedAt: 2,
    outputs,
  }],
})

describe('Agent RAG source display helpers', () => {
  it('extracts, deduplicates, and formats persisted source outputs', () => {
    const message = createMessage([
      {
        id: 'source-1', type: 'source', title: '旧标题', path: 'docs/guide.md', content: '检索片段',
        metadata: { score: 0.916 },
      },
      {
        id: 'source-2', type: 'source', title: '重复', path: 'docs/guide.md', content: '重复片段',
      },
      { id: 'result', type: 'text', title: '结果摘要', content: '不应展示' },
    ])

    const sources = getAgentRagSources(message)
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      id: 'source-1',
      index: 1,
      title: 'guide.md',
      path: 'docs/guide.md',
      content: '检索片段',
    })
    expect(sources[0].score).toBeCloseTo(91.6)
    expect(formatAgentRagSourceScore(sources[0].score)).toBe('92%')
  })

  it('returns every unique persisted source instead of truncating the list', () => {
    const outputs = Array.from({ length: 12 }, (_, index) => ({
      id: `source-${index + 1}`,
      type: 'source' as const,
      title: `source-${index + 1}.md`,
      path: `docs/source-${index + 1}.md`,
      content: `片段 ${index + 1}`,
    }))

    const sources = getAgentRagSources(createMessage(outputs))
    expect(sources).toHaveLength(12)
    expect(sources.at(-1)?.path).toBe('docs/source-12.md')
  })

  it('does not expose unsafe absolute or parent-traversal source paths', () => {
    const message = createMessage([
      { id: 'source-1', type: 'source', title: '绝对路径', path: 'C:/secret.txt', content: '片段' },
      { id: 'source-2', type: 'source', title: '越界路径', path: '../secret.txt', content: '片段' },
    ])

    expect(getAgentRagSources(message).map(source => source.path)).toEqual(['', ''])
  })
})
