import type { AgentEvent, MemoryUpdatedPayload } from '../types/agent-events'
import type { AgentMemoryDocument } from '../types/agent-memory'
import { diffMemoryLines } from './agent-memory-changes'
import { orderAgentEvents } from './agent-event-projections'

/** Main only: retain at most one bounded baseline, not a growing patch log.
 * Revision gaps split attribution: manual/other-run changes are never ours. */
export function createMemoryRunDelta(kind: MemoryUpdatedPayload['kind'] = 'user', workspaceId?: string) {
  let baseline: AgentMemoryDocument | undefined
  let previousRevision: string | undefined
  let segment = 0
  const preview = (before: AgentMemoryDocument, after: AgentMemoryDocument): MemoryUpdatedPayload => {
    const continuous = baseline && previousRevision === before.revision
    return {
      kind, ...(kind === 'workspace' ? { workspaceId } : {}), beforeRevision: before.revision, afterRevision: after.revision,
      changes: diffMemoryLines(before.content, after.content),
      net: { segment: continuous ? segment : segment + 1, changes: diffMemoryLines((continuous ? baseline : before).content, after.content) },
    }
  }
  return {
    // Intent creation must not advance the successful-save baseline.
    preview,
    record(before: AgentMemoryDocument, after: AgentMemoryDocument): MemoryUpdatedPayload {
      const change = preview(before, after)
      if (!baseline || previousRevision !== before.revision) { baseline = before; segment++ }
      previousRevision = after.revision
      return change
    },
  }
}

/** Project a single run's durable receipts. A gap makes earlier additions
 * unverifiable at the final state: preserve only a static update indicator for
 * those segments, not possibly retracted text. Legacy multi-save receipts have
 * no positional/baseline metadata and likewise must not invent a net diff. */
export function projectMemoryUpdates(events: readonly AgentEvent[]): Array<{ id: string; changes: MemoryUpdatedPayload['changes']; kind?: MemoryUpdatedPayload['kind']; workspaceId?: string }> {
  const scopes = new Map<string, AgentEvent[]>()
  for (const event of orderAgentEvents([...events])) {
    if (event.type !== 'memory_updated') continue
    const key = JSON.stringify([event.runId, event.payload.kind, event.payload.workspaceId ?? ''])
    const group = scopes.get(key) ?? []
    group.push(event); scopes.set(key, group)
  }
  return [...scopes.values()].flatMap(group => {
    const first = group[0] as Extract<AgentEvent, { type: 'memory_updated' }>
    return projectScopeUpdates(group).map(update => first.payload.kind === 'workspace'
      ? { ...update, kind: 'workspace' as const, workspaceId: first.payload.workspaceId }
      : update)
  })
}
function projectScopeUpdates(events: readonly AgentEvent[]) {
  const seen = new Set<string>()
  const receipts = orderAgentEvents([...events]).filter((event): event is Extract<AgentEvent, { type: 'memory_updated' }> => {
    if (event.type !== 'memory_updated' || seen.has(event.id) || event.payload.beforeRevision === event.payload.afterRevision) return false
    seen.add(event.id)
    return event.payload.changes.length > 0
  })
  if (!receipts.length) return []
  const last = receipts[receipts.length - 1]
  if (!last.payload.net) {
    return [{ id: last.id, changes: receipts.length === 1 ? last.payload.changes : [] }]
  }
  const latest = last.payload.net
  const segments = new Map<number, typeof last>()
  for (const event of receipts) if (event.payload.net) segments.set(event.payload.net.segment, event)
  const prior = receipts.find(event => !event.payload.net)
    ?? [...segments.values()].find(event => event.payload.net!.segment !== latest.segment && event.payload.net!.changes.length > 0)
  const result: Array<{ id: string; changes: MemoryUpdatedPayload['changes'] }> = prior ? [{ id: prior.id, changes: [] }] : []
  if (latest.changes.length) result.push({ id: last.id, changes: latest.changes })
  return result
}
