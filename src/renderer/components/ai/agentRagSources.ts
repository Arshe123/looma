import type { AiAssistantMessage } from '@/renderer/stores/workspace'
import { normalizeAiAssistantSourcePath } from '@/renderer/stores/workspace-ai-utils'

export interface AgentRagSourceDisplayItem {
  id: string
  index: number
  title: string
  path: string
  content: string
  score?: number
}

const normalizeScore = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const percentage = value <= 1 ? value * 100 : value
  return Math.max(0, Math.min(100, percentage))
}

export const getAgentRagSources = (message: AiAssistantMessage): AgentRagSourceDisplayItem[] => {
  const seen = new Set<string>()
  const sources: AgentRagSourceDisplayItem[] = []

  for (const step of message.timeline || []) {
    for (const output of step.outputs || []) {
      if (output.type !== 'source') continue
      const path = normalizeAiAssistantSourcePath(output.path || '')
      const title = path.split('/').pop() || output.title?.trim() || `来源 ${sources.length + 1}`
      const content = output.content?.trim() || ''
      const dedupeKey = path || `${title}:${content}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      sources.push({
        id: output.id || `agent-rag-source-${sources.length + 1}`,
        index: sources.length + 1,
        title,
        path,
        content,
        score: normalizeScore(output.metadata?.score),
      })
    }
  }

  return sources
}

export const formatAgentRagSourceScore = (score?: number) => (
  score === undefined ? '' : `${Math.round(score)}%`
)
