export type AgentMemoryKind = 'soul' | 'user'
export interface AgentMemoryDocument { content: string; revision: string }
export interface AgentMemorySnapshot { soul: AgentMemoryDocument; user: AgentMemoryDocument }
export const MAX_MEMORY_CHARS = 16000
