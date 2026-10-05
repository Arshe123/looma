export type AgentMemoryKind = 'soul' | 'user'
export interface AgentMemoryDocument { content: string; revision: string }
export interface AgentMemorySnapshot { soul: AgentMemoryDocument; user: AgentMemoryDocument }
export const MAX_MEMORY_CHARS = 16000

/** A durable pre-write snapshot, not proof the subsequent write committed.
 * source identifies the operation that requested the backup, not its author. */
export interface UserProfileHistoryEntry extends AgentMemoryDocument {
  id: string
  createdAt: number
  source: 'manual' | 'agent' | 'restore'
}
export interface UserProfileHistoryPage {
  entries: Omit<UserProfileHistoryEntry, 'content'>[]
  nextCursor?: string
}
