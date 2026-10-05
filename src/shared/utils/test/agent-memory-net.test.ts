import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createMemoryRunDelta, projectMemoryUpdates } from '../agent-memory-net'
import type { AgentEvent, MemoryUpdatedPayload } from '../../types/agent-events'
const doc = (content: string) => ({ content, revision: createHash('sha256').update(content).digest('hex') })
const event = (payload: MemoryUpdatedPayload, sequence: number): Extract<AgentEvent, { type: 'memory_updated' }> => ({ id: `e${sequence}`, sequence, runId: 'run', taskId: 'task', timestamp: sequence, family: 'artifact', type: 'memory_updated', payload })

it('projects exact first-to-final changes, not retracted additions, identically after JSON replay', () => {
  const delta = createMemoryRunDelta()
  const first = event(delta.record(doc('existing\n重复'), doc('existing\n重复\n临时\n重复')), 1)
  const final = event(delta.record(doc('existing\n重复\n临时\n重复'), doc('existing\n重复\n最终🙂\n重复')), 2)
  const expected = [{ id: 'e2', changes: [{ type: 'added', text: '最终🙂\n重复' }] }]
  expect(projectMemoryUpdates([final, first, first])).toEqual(expected)
  expect(projectMemoryUpdates(JSON.parse(JSON.stringify([first, final])))).toEqual(expected)
  expect(JSON.stringify(final.payload)).not.toContain('existing')
})

it('hides total reversions and retains real delete-only changes', () => {
  const delta = createMemoryRunDelta()
  const first = event(delta.record(doc('旧\n内容'), doc('新\n内容')), 1)
  const revert = event(delta.record(doc('新\n内容'), doc('旧\n内容')), 2)
  expect(projectMemoryUpdates([first, revert])).toEqual([])
  const clear = event(delta.record(doc('旧\n内容'), doc('')), 3)
  expect(projectMemoryUpdates([first, revert, clear])).toEqual([{ id: 'e3', changes: [{ type: 'removed', text: '旧\n内容' }] }])
})

it('uses a new segment across revision gaps and never attributes other writers or stale additions', () => {
  const delta = createMemoryRunDelta()
  const first = event(delta.record(doc('base'), doc('base\nretracted elsewhere')), 1)
  const next = event(delta.record(doc('base\nmanual'), doc('base\nmanual\nours')), 2)
  const projected = projectMemoryUpdates([first, next])
  expect(projected).toEqual([{ id: 'e1', changes: [] }, { id: 'e2', changes: [{ type: 'added', text: 'ours' }] }])
  expect(JSON.stringify(projected)).not.toContain('manual')
  expect(JSON.stringify(projected)).not.toContain('retracted')
})

it('keeps single legacy receipts readable but multiple uncomposable legacy receipts static', () => {
  const first = event({ kind: 'user', beforeRevision: 'a', afterRevision: 'b', changes: [{ type: 'added', text: 'old' }] }, 1)
  const second = event({ kind: 'user', beforeRevision: 'b', afterRevision: 'c', changes: [{ type: 'added', text: 'new' }] }, 2)
  expect(projectMemoryUpdates([first])).toEqual([{ id: 'e1', changes: first.payload.changes }])
  expect(projectMemoryUpdates([first, second])).toEqual([{ id: 'e2', changes: [] }])
})
