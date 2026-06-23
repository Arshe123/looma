import { normalizeDir } from './workspace-utils'
import { getFilePathsFromTabs, normalizeWorkspaceTabs } from './workspace-tab-utils'
import type { EditorSession, SidebarPanelId, WorkspaceMeta, WorkspaceTab } from './workspace-types'

interface BuildWorkspaceMetaInput {
  expandedDirs: string[]
  selectedPaths: string[]
  noteOrder: Record<string, string[]>
  openedFiles: string[]
  activeFileRelativePath: string
  tabs?: WorkspaceTab[]
  activeTabId?: string
  fileSessions: Record<string, EditorSession>
  activeSidebarPanel?: SidebarPanelId | null
}

const cloneNoteOrder = (noteOrder: Record<string, string[]>) => {
  const noteOrderPlain: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(noteOrder || {})) {
    noteOrderPlain[k] = Array.isArray(v) ? v.slice() : []
  }
  return noteOrderPlain
}

const cleanupSessionsForOpenedFiles = (openedFiles: string[], fileSessions: Record<string, EditorSession>) => {
  const cleanedSessions: Record<string, EditorSession> = {}
  for (const file of openedFiles) {
    if (fileSessions[file]) {
      cleanedSessions[file] = fileSessions[file]
    }
  }
  return cleanedSessions
}

export const buildWorkspaceMetaPayload = (input: BuildWorkspaceMetaInput) => {
  const noteOrderPlain = cloneNoteOrder(input.noteOrder)
  const normalizedTabs = normalizeWorkspaceTabs(input.tabs)
  const openedFiles = normalizedTabs.length > 0
    ? getFilePathsFromTabs(normalizedTabs)
    : input.openedFiles.map(normalizeDir)
  const cleanedSessions = cleanupSessionsForOpenedFiles(openedFiles, input.fileSessions)
  const activeTabId = input.activeTabId && normalizedTabs.some((tab) => tab.id === input.activeTabId)
    ? input.activeTabId
    : undefined
  const meta: WorkspaceMeta = {
    expandedDirs: input.expandedDirs.map(normalizeDir),
    selectedPaths: input.selectedPaths.map(normalizeDir),
    noteOrder: noteOrderPlain,
    openedFiles,
    activeFile: input.activeFileRelativePath || undefined,
    tabs: normalizedTabs.length > 0 ? normalizedTabs : undefined,
    activeTabId,
    fileSessions: JSON.parse(JSON.stringify(cleanedSessions)),
    activeSidebarPanel: input.activeSidebarPanel,
  }
  return { cleanedSessions, meta }
}
