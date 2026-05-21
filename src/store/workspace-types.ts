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

export interface AiAssistantMessage {
  id: number
  role: AiAssistantMessageRole
  text: string
  createdAt: number
  actions?: AiAssistantMessageAction[]
}

export interface AiAssistantConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: AiAssistantMessage[]
  draft: string
}

export interface AiAssistantState {
  conversations: AiAssistantConversation[]
  activeConversationId: string
}

export type SidebarPanelId = 'files' | 'outline' | 'ai'
export type SystemPageId = 'settings'

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
