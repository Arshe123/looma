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
  markdown?: { viewMode: 'split' | 'editor' | 'preview' }
  plaintext?: { fontSize: number; wordWrap: boolean }
  codemirror?: {
    anchor: number
    head: number
    scrollTop: number
  }
}

export interface WorkspaceMeta {
  expandedDirs: string[]
  selectedPaths: string[]
  noteOrder: Record<string, string[]>
  openedFiles?: string[]
  activeFile?: string
  fileSessions?: Record<string, EditorSession>
}

export type UndoAction =
  | { type: 'create'; relativePath: string }
  | { type: 'move'; items: { from: string; to: string }[] }
  | { type: 'delete'; items: { trashRelativePath: string; restoreTo: string }[] }
