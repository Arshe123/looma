export type AgentContextLimits = {
  contextWindowTokens: number
  maxInputTokens?: number
  maxOutputTokens?: number
}

export const AGENT_CONTEXT_PARTS = ['system', 'memory', 'history', 'input', 'tools', 'outputReserve'] as const

export type AgentContextUsage = {
  limitTokens: number
  usedTokens: number
  estimated: boolean
  parts: Record<(typeof AGENT_CONTEXT_PARTS)[number], number>
}
