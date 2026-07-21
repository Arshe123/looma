export const AGENT_TOOL_NAMES = [
  'rag_search',
  'workspace_list',
  'workspace_search',
  'file_read',
  'file_patch',
] as const

export type AgentToolName = typeof AGENT_TOOL_NAMES[number]

export interface AgentToolCallMessage {
  id: string
  type: 'function'
  function: {
    name: AgentToolName
    arguments: Record<string, unknown>
  }
}

export interface AgentMessage {
  id: string
  conversationId: string
  taskId?: string
  runId?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  createdAt: number
  tool_calls?: AgentToolCallMessage[]
  tool_call_id?: string
  name?: AgentToolName
}
