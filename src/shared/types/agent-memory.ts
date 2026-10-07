export type AgentMemoryKind = 'soul' | 'user'
/** Main-owned invalidation, never profile plaintext. Missing revision means
 * a commit may have reached disk but durability could not be confirmed. */
export interface AgentMemoryInvalidation { kind: AgentMemoryKind; revision?: string }
export interface AgentMemoryDocument { content: string; revision: string }
export interface AgentMemorySnapshot { soul: AgentMemoryDocument; user: AgentMemoryDocument }
export const MAX_MEMORY_CHARS = 16000
export interface MemoryCleanupSelection { history: boolean; snapshots: boolean; user: boolean }
export interface MemoryCleanupPreview {
  selection: MemoryCleanupSelection
  token: string
  counts: { history: number; snapshots: number; user: number; receipts: number }
  records: string[]
  skipped: string[]
}

/** A durable pre-write snapshot, not proof the subsequent write committed.
 * source identifies the operation that requested the backup, not its author. */
export interface UserProfileHistoryEntry extends AgentMemoryDocument {
  id: string
  createdAt: number
  source: 'manual' | 'agent' | 'restore'
}
export type UserProfileHistoryListEntry =
  | (Omit<UserProfileHistoryEntry, 'content'> & { status: 'valid' })
  | { id: string; createdAt: number; status: 'invalid'; error: string; source?: never; revision?: never }
export interface UserProfileHistoryPage {
  entries: UserProfileHistoryListEntry[]
  nextCursor?: string
}
