import { normalizeDir } from './workspace-utils'
import { getFilePathsFromTabs, normalizeWorkspaceTabs } from './workspace-tab-utils'
import type { EditorSession, SidebarPanelId, WorkspaceMeta, WorkspaceTab } from './workspace-types'

interface BuildWorkspaceMetaInput {
  expandedDirs: string[]
  selectedPaths: string[]
  noteOrder: Record<string, string[]>
  openedFiles?: string[]
  activeFileRelativePath: string
  tabs?: WorkspaceTab[]
  activeTabId?: string
  previewTabId?: string
  fileSessions: Record<string, EditorSession>
  outlineExpandedHeadingIds: Record<string, string[]>
  activeSidebarPanel?: SidebarPanelId | null
  fileSidebarOpen?: boolean
  activeAuxiliaryPanel?: 'outline' | 'ai' | null
  fileSortMode?: 'name' | 'created-asc' | 'created-desc'
  fileCreationTimes?: Record<string, number>
  trashedFileCreationTimes?: Record<string, { restoreTo: string; entries: Record<string, number> }>
}

const cloneNoteOrder = (noteOrder: Record<string, string[]>) => {
  const noteOrderPlain: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(noteOrder || {})) {
    noteOrderPlain[k] = Array.isArray(v) ? v.slice() : []
  }
  return noteOrderPlain
}

const cloneStringArrayRecord = (value: Record<string, string[]>) => {
  const result: Record<string, string[]> = {}
  for (const [key, entries] of Object.entries(value || {})) {
    result[key] = Array.isArray(entries) ? entries.slice() : []
  }
  return result
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
  const allTabs = normalizeWorkspaceTabs(input.tabs)
  const normalizedTabs = allTabs
    .filter((tab) => tab.id !== input.previewTabId && !(tab.kind === 'system' && tab.page === 'agent-diff'))
  const openedFiles = Array.isArray(input.tabs)
    ? getFilePathsFromTabs(normalizedTabs)
    : (input.openedFiles ?? []).map(normalizeDir)
  // Temporary previews retain their reading state until closed, but not across restarts.
  const runtimeFiles = Array.isArray(input.tabs) ? getFilePathsFromTabs(allTabs) : openedFiles
  const cleanedSessions = cleanupSessionsForOpenedFiles(runtimeFiles, input.fileSessions)
  const activeTabId = input.activeTabId && normalizedTabs.some((tab) => tab.id === input.activeTabId)
    ? input.activeTabId
    : undefined
  const meta: WorkspaceMeta = {
    expandedDirs: input.expandedDirs.map(normalizeDir),
    selectedPaths: input.selectedPaths.map(normalizeDir),
    noteOrder: noteOrderPlain,
    openedFiles,
    activeFile: openedFiles.includes(input.activeFileRelativePath) ? input.activeFileRelativePath : undefined,
    tabs: normalizedTabs.length > 0 ? normalizedTabs : undefined,
    activeTabId,
    fileSessions: JSON.parse(JSON.stringify(cleanupSessionsForOpenedFiles(openedFiles, cleanedSessions))),
    outlineExpandedHeadingIds: cloneStringArrayRecord(input.outlineExpandedHeadingIds),
    outlineExpansionStateVersion: 1,
    activeSidebarPanel: input.activeSidebarPanel,
    fileSidebarOpen: input.fileSidebarOpen,
    activeAuxiliaryPanel: input.activeAuxiliaryPanel,
    fileSortMode: input.fileSortMode,
    fileCreationTimes: { ...input.fileCreationTimes },
    trashedFileCreationTimes: JSON.parse(JSON.stringify(input.trashedFileCreationTimes || {})),
  }
  return { cleanedSessions, meta }
}
