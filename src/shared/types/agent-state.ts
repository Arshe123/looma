export type AgentRunStatus = 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'
export type AgentTaskStatus = 'active' | 'completed' | 'failed' | 'cancelled'

export interface AgentState {
  status: AgentRunStatus
  currentStep: string
  pendingApproval?: string
  completedSteps: string[]
}

export interface AgentTaskPolicy {
  maxRuns: number
  maxTotalToolCalls: number
  maxTotalModelCalls: number
  maxTotalWallTimeMs: number
  maxTotalCostUsd?: number
}

export interface AgentTask {
  id: string
  conversationId: string
  goal: string
  constraints: string[]
  createdAt: number
  updatedAt: number
  status: AgentTaskStatus
  runIds: string[]
  activeRunId?: string
  latestRunId?: string
  policy: AgentTaskPolicy
}

export interface AgentRun {
  id: string
  taskId: string
  conversationId: string
  requestId: string
  parentRunId?: string
  recoveryReason?: 'app_restart' | 'service_restart' | 'provider_interrupted' | 'approval_continuation' | 'manual_retry'
  inputMessageId: string
  assistantMessageId: string
  createdAt: number
  endedAt?: number
}

export interface RuntimeCheckpoint {
  version: number
  taskId: string
  runId: string
  throughSequence: number
  eventLogPrefixHash: string
  messageCursor: string
  messageTranscriptHash: string
  nextStep: number
  remainingToolSteps: number
  completedCallDigests: string[]
  pendingApprovalRef?: {
    approvalId: string
    artifactId: string
    callId: string
  }
  providerCache?: unknown
}
