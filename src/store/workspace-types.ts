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

export type SidebarPanelId = 'files' | 'outline'
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
