export interface Workspace {
  id: string
  name: string
  path: string
  createdAt: number
  lastOpenedAt: number
}

export interface FsEntry {
  name: string
  relativePath: string
  isDirectory: boolean
  size: number
  mtimeMs: number
}

export interface EditorSession {
  updatedAt: number
  markdown?: { viewMode: 'split' | 'editor' | 'preview'; splitRatio?: number }
  plaintext?: { fontSize: number; wordWrap: boolean }
  codemirror?: {
    anchor: number
    head: number
    scrollTop: number
  }
}

export interface OpenTextFileState {
  content: string
  loadedContent: string
  isSaving: boolean
  saveError: string
}

export type AiAssistantMessageRole = 'assistant' | 'user' | 'system'

export interface AiAssistantMessageAction {
  type: 'build-index'
  title: string
  description: string
  buttonText: string
  disabled?: boolean
}

export type AiAssistantTimelineStepStatus = 'pending' | 'active' | 'completed' | 'error'

export type AiAssistantTimelineOutputType = 'text' | 'source' | 'metric' | 'code' | 'json' | 'error'

export interface AiAssistantTimelineOutput {
  id: string
  type: AiAssistantTimelineOutputType
  title?: string
  content?: string
  value?: string | number
  unit?: string
  path?: string
  metadata?: Record<string, unknown>
}

export interface AiAssistantTimelineStep {
  id: string
  title: string
  description?: string
  detail?: string
  status: AiAssistantTimelineStepStatus
  startedAt: number
  endedAt?: number
  outputs: AiAssistantTimelineOutput[]
}

export interface AiAssistantModelIdentity {
  provider: string
  model: string
  displayName: string
}

export interface AiAssistantAgentSummary {
  status: 'running' | 'completed' | 'cancelled' | 'error'
  toolCallCount?: number
  sourceCount?: number
  error?: {
    message: string
    technicalDetail?: string
  }
}

export interface AiAssistantMessage {
  id: number
  role: AiAssistantMessageRole
  text: string
  createdAt: number
  aiName?: string
  actions?: AiAssistantMessageAction[]
  timeline?: AiAssistantTimelineStep[]
  runId?: string
  mode?: 'rag' | 'agent'
  modelIdentity?: AiAssistantModelIdentity
  agentSummary?: AiAssistantAgentSummary
}

export interface AiAssistantConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: AiAssistantMessage[]
  draft: string
  archived?: boolean
  archivedAt?: number
  pinned?: boolean
  pinnedAt?: number
  favorite?: boolean
  favoriteCategory?: string
  titleEdited?: boolean
}

export interface AiAssistantState {
  conversations: AiAssistantConversation[]
  activeConversationId: string | null
  temporaryDraft?: string
  isTemporaryConversation?: boolean
}

export type SidebarPanelId = 'files' | 'outline' | 'ai'
export type SystemPageId = 'settings' | 'rag-index' | 'ai-history'
export type SettingsSectionId = 'appearance' | 'editor' | 'ai'

export type WorkspaceTabKind = 'file' | 'system'

export interface FileWorkspaceTab {
  id: string
  kind: 'file'
  relativePath: string
}

export interface SystemWorkspaceTab {
  id: string
  kind: 'system'
  page: SystemPageId
}

export type WorkspaceTab = FileWorkspaceTab | SystemWorkspaceTab

export interface SidebarPanelState {
  id: SidebarPanelId
  size: number
}

export interface WorkspaceMeta {
  expandedDirs: string[]
  selectedPaths: string[]
  noteOrder: Record<string, string[]>
  openedFiles?: string[]
  activeFile?: string
  tabs?: WorkspaceTab[]
  activeTabId?: string
  fileSessions?: Record<string, EditorSession>
  activeSidebarPanel?: SidebarPanelId | null
  sidebarPanels?: SidebarPanelState[]
}

export type ResolvedThemeName = 'light' | 'dark'
export type ThemeName = ResolvedThemeName | 'system'

export type UndoAction =
  | { type: 'create'; relativePath: string }
  | { type: 'restore'; trashRelativePath: string; restoreTo: string }
  | { type: 'move'; items: { from: string; to: string }[] }
  | { type: 'delete'; items: { trashRelativePath: string; restoreTo: string }[] }
