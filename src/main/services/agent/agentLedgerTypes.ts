import type { AgentEvent, AgentSource, FilePatchArtifact } from '../../../shared/types/agent-events'
import type { AgentMessage } from '../../../shared/types/agent-message'
import type { AgentRun, AgentTask, RuntimeCheckpoint } from '../../../shared/types/agent-state'
import type { EventSnapshot } from '../../../shared/utils/agent-event-projections'

export interface AgentOutboxEntry {
  callId: string
  taskId: string
  runId: string
  tool: string
  status: 'pending' | 'completed' | 'failed'
  updatedAt: number
  resultEventId?: string
}

export interface AgentLedgerTransaction {
  schemaVersion: 1
  ledgerSequence: number
  txId: string
  createdAt: number
  kind: 'task_created' | 'run_created' | 'tool_call_commit' | 'tool_result_commit' | 'event_commit' | 'message_commit' | 'source_commit'
  tasks?: AgentTask[]
  runs?: AgentRun[]
  messages?: AgentMessage[]
  events?: AgentEvent[]
  sources?: AgentSource[]
  outbox?: AgentOutboxEntry[]
}

export interface AgentLedgerView {
  tasks: Record<string, AgentTask>
  runs: Record<string, AgentRun>
  messages: AgentMessage[]
  events: AgentEvent[]
  sources: AgentSource[]
  outbox: Record<string, AgentOutboxEntry>
}

export interface AgentCacheEnvelope<T> {
  cacheVersion: number
  taskId: string
  runId: string
  eventLogPrefixHash: string
  throughSequence: number
  value: T
}

export type AgentSnapshotEnvelope = AgentCacheEnvelope<EventSnapshot>
export type RuntimeCheckpointEnvelope = AgentCacheEnvelope<RuntimeCheckpoint>

export interface AgentArtifactEnvelope {
  schemaVersion: 1
  artifact: FilePatchArtifact
}
