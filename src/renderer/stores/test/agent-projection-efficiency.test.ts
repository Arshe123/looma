import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as projections from '../../../shared/utils/agent-event-projections'
import * as view from '../agent-event-view'
import { useAiAssistantStore } from '../ai-assistant'
import type { AgentEvent } from '../../../shared/types/agent-events'

const events: AgentEvent[] = [
  { id: 'failed', taskId: 'task', runId: 'run', sequence: 3, timestamp: 3, family: 'execution', type: 'run_failed', payload: { code: 'failed', message: 'failure', recoverable: true } },
  { id: 'call', taskId: 'task', runId: 'run', sequence: 2, timestamp: 2, family: 'execution', type: 'tool_call_requested', payload: { callId: 'call', stepId: 'step', tool: 'file_read', argumentsDigest: '', argumentsPreview: {}, startedAt: 2 } },
  { id: 'thought', taskId: 'task', runId: 'run', sequence: 1, timestamp: 1, family: 'execution', type: 'thought_summary', payload: { stepId: 'step', callId: 'call', summary: 'inspect' } },
]

afterEach(() => { vi.restoreAllMocks() })

describe('agent projection work budget', () => {
  it('projects only display events from the message getter', () => {
    setActivePinia(createPinia())
    const store = useAiAssistantStore()
    store.agentEventsByMessageKey['conversation:0'] = [...events]
    const fullView = vi.spyOn(view, 'projectAgentRunView')
    const display = vi.spyOn(view, 'projectAgentDisplayEvents')
    expect(store.getMessageAgentDisplayEvents('conversation', 0).map(event => event.id)).toEqual(['thought', 'call'])
    expect(fullView).not.toHaveBeenCalled()
    expect(display).toHaveBeenCalledTimes(1)
    expect(store.getMessageAgentDisplayEvents(null, 0)).toEqual([])
    expect(store.getMessageAgentDisplayEvents('conversation', undefined)).toEqual([])
  })

  it.each([
    ['full view', (input: AgentEvent[]) => view.projectAgentRunView(input, [])],
    ['display', (input: AgentEvent[]) => view.projectAgentDisplayEvents(input)],
    ['timeline', (input: AgentEvent[]) => view.projectAgentTimeline(input, [])],
    ['approvals', (input: AgentEvent[]) => view.projectAgentApprovals(input)],
    ['indexes', projections.projectEventIndexes],
    ['snapshot', (input: AgentEvent[]) => projections.createEventSnapshot('run', input, 'hash')],
  ])('sorts an unordered ledger only once for %s, and skips sorting ordered ledgers', (_name, project) => {
    const input = [...events]
    const sorted = [...events].reverse()
    const sort = vi.spyOn(Array.prototype, 'sort')
    const result = project(input)
    const unorderedSortCount = sort.mock.calls.length
    sort.mockClear()
    const orderedResult = project(sorted)
    const orderedSortCount = sort.mock.calls.length
    sort.mockRestore()
    expect(orderedResult).toEqual(result)
    expect(input).toEqual(events)
    expect(unorderedSortCount).toBe(1)
    expect(orderedSortCount).toBe(0)
  })

  it('looks up artifact completion times without rescanning the ledger per patch', () => {
    let sequenceReads = 0
    const input: AgentEvent[] = []
    for (let index = 0; index < 40; index += 1) {
      const sequence = input.length + 1
      input.push({
        id: `call-${index}`, taskId: 'task', runId: 'run', sequence, timestamp: sequence,
        family: 'execution', type: 'tool_call_requested',
        payload: { callId: `call-${index}`, stepId: `step-${index}`, tool: 'file_patch', argumentsDigest: '', argumentsPreview: {}, startedAt: sequence },
      }, {
        id: `artifact-${index}`, taskId: 'task', runId: 'run', sequence: sequence + 1, timestamp: sequence + 1,
        family: 'artifact', type: 'artifact_created',
        payload: { artifactId: `artifact-${index}`, callId: `call-${index}`, kind: 'file_patch', path: 'test.md', beforeHash: null, afterHash: 'hash', operation: 'create', diff: '+text', additions: 1, deletions: 0, createdAt: sequence + 1, expiresAt: 1000 },
      })
    }
    for (const event of input) {
      const sequence = event.sequence
      Object.defineProperty(event, 'sequence', { get: () => { sequenceReads += 1; return sequence } })
    }
    const timeline = view.projectAgentTimeline(input, [])
    const reads = sequenceReads
    expect(timeline).toHaveLength(40)
    expect(timeline.map(step => step.endedAt)).toEqual(Array.from({ length: 40 }, (_, index) => index * 2 + 2))
    expect(reads).toBeLessThan(input.length * 30)
  })

  it('folds state and builds indexes only once for the complete view', () => {
    const fold = vi.spyOn(projections, 'foldAgentState')
    const indexes = vi.spyOn(projections, 'projectEventIndexes')
    const result = view.projectAgentRunView(events, [])
    expect(result.displayEvents.map(event => event.id)).toEqual(['thought', 'call'])
    expect(result.timeline[0]).toMatchObject({ id: 'step', status: 'error', endedAt: 3 })
    expect(fold).toHaveBeenCalledTimes(1)
    expect(indexes).toHaveBeenCalledTimes(1)
    expect(events.map(event => event.sequence)).toEqual([3, 2, 1])
  })
})
