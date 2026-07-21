import type { AgentToolName } from './agent-message'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface AgentEventBase {
  id: string
  sequence: number
  taskId: string
  runId: string
  timestamp: number
}

export interface AgentStartedPayload {
  requestId: string
  inputMessageId: string
  assistantMessageId: string
  modelIdentity: { provider: string; model: string }
  contextVersion: number
}

export interface ThoughtSummaryPayload {
  stepId: string
  callId?: string
  summary: string
}

export interface ToolCallPayload {
  stepId: string
  callId: string
  tool: AgentToolName
  argumentsPreview: Record<string, JsonValue>
  argumentsDigest: string
  startedAt: number
}

export interface ToolResultModelContext {
  facts: string[]
  structuredData: Record<string, JsonValue>
}

export interface ToolResultPayload {
  stepId: string
  callId: string
  tool: AgentToolName
  status: 'completed' | 'failed' | 'cancelled'
  durationMs: number
  uiSummary: string
  modelContext: ToolResultModelContext
  error?: {
    code: string
    message: string
    technicalDetail?: string
    recoverable: boolean
  }
}

export interface RetrievalCompletedPayload {
  retrievalId: string
  callId: string
  tool: 'rag_search'
  queryDigest: string
  sourceIds: string[]
  sourceCount: number
  durationMs: number
}

export interface UsageUpdatePayload {
  operationId: string
  phase: 'decision' | 'repair' | 'final' | 'summary' | 'embedding' | 'rerank'
  provider: string
  model: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cost?: {
    amount: number
    currency: 'USD'
    estimated: boolean
  }
  latencyMs: number
}

export interface RunCompletedPayload {
  answerMessageId: string
  completedStep?: string
}

export interface RunFailedPayload {
  code: string
  message: string
  technicalDetail?: string
  recoverable: boolean
}

export interface RunCancelledPayload {
  reason: string
}

export type ExecutionEvent = AgentEventBase & (
  | { family: 'execution'; type: 'agent_started'; payload: AgentStartedPayload }
  | { family: 'execution'; type: 'thought_summary'; payload: ThoughtSummaryPayload }
  | { family: 'execution'; type: 'tool_call_requested'; payload: ToolCallPayload }
  | { family: 'execution'; type: 'tool_result_recorded'; payload: ToolResultPayload }
  | { family: 'execution'; type: 'retrieval_completed'; payload: RetrievalCompletedPayload }
  | { family: 'execution'; type: 'usage_updated'; payload: UsageUpdatePayload }
  | { family: 'execution'; type: 'run_completed'; payload: RunCompletedPayload }
  | { family: 'execution'; type: 'run_failed'; payload: RunFailedPayload }
  | { family: 'execution'; type: 'run_cancelled'; payload: RunCancelledPayload }
)

export interface ArtifactCreatedPayload {
  artifactId: string
  callId: string
  kind: 'file_patch'
  path: string
  beforeHash: string | null
  afterHash: string
  operation: 'create' | 'update'
  diff: string
  additions: number
  deletions: number
  createdAt: number
  expiresAt: number
}

export interface ApprovalRequiredPayload {
  approvalId: string
  callId: string
  artifactId: string
  deadlineAt: number
}

export interface ApprovalResolvedPayload {
  approvalId: string
  callId: string
  artifactId: string
  status: 'approved' | 'rejected' | 'expired' | 'cancelled'
  applied: boolean
  reason?: string
}

export interface FilePatchAppliedPayload {
  approvalId: string
  artifactId: string
  callId: string
  path: string
  beforeHash: string | null
  afterHash: string
}

export interface FilePatchConflictPayload {
  approvalId: string
  artifactId: string
  callId: string
  path: string
  expectedHash: string | null
  actualHash: string | null
}

export interface FilePatchFailedPayload {
  approvalId: string
  artifactId: string
  callId: string
  path: string
  code: string
  message: string
}

export type ArtifactEvent = AgentEventBase & (
  | { family: 'artifact'; type: 'artifact_created'; payload: ArtifactCreatedPayload }
  | { family: 'artifact'; type: 'approval_required'; payload: ApprovalRequiredPayload }
  | { family: 'artifact'; type: 'approval_resolved'; payload: ApprovalResolvedPayload }
  | { family: 'artifact'; type: 'file_patch_applied'; payload: FilePatchAppliedPayload }
  | { family: 'artifact'; type: 'file_patch_conflict'; payload: FilePatchConflictPayload }
  | { family: 'artifact'; type: 'file_patch_failed'; payload: FilePatchFailedPayload }
)

export interface RunInterruptedPayload {
  reason: 'app_restart' | 'service_restart' | 'provider_interrupted'
  recoverable: boolean
}

export interface ContinuationCreatedPayload {
  parentRunId: string
  recoveryReason: 'app_restart' | 'service_restart' | 'provider_interrupted' | 'approval_continuation' | 'manual_retry'
}

export interface ApprovalInheritedPayload {
  parentRunId: string
  approvalId: string
  artifactId: string
  callId: string
}

export interface RecoveryFailedPayload {
  parentRunId: string
  code: string
  message: string
}

export type RecoveryEvent = AgentEventBase & (
  | { family: 'recovery'; type: 'run_interrupted'; payload: RunInterruptedPayload }
  | { family: 'recovery'; type: 'continuation_created'; payload: ContinuationCreatedPayload }
  | { family: 'recovery'; type: 'approval_inherited'; payload: ApprovalInheritedPayload }
  | { family: 'recovery'; type: 'recovery_failed'; payload: RecoveryFailedPayload }
)

export type AgentEvent = ExecutionEvent | ArtifactEvent | RecoveryEvent

export interface AgentSource {
  sourceId: string
  retrievalId: string
  taskId: string
  runId: string
  path: string
  snippet: string
  score?: number
}

export interface FilePatchArtifact {
  artifactId: string
  taskId: string
  runId: string
  callId: string
  approvalId: string
  workspaceId: string
  path: string
  operation: 'create' | 'update'
  beforeHash: string | null
  afterHash: string
  diff: string
  proposedContent: string
  createdAt: number
  expiresAt: number
}
