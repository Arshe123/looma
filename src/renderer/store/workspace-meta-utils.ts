import { normalizeDir } from './workspace-utils'
import type { EditorSession, WorkspaceMeta } from './workspace-types'

interface BuildWorkspaceMetaInput {
  expandedDirs: string[]
  selectedPaths: string[]
  noteOrder: Record<string, string[]>
  openedFiles: string[]
  activeFileRelativePath: string
  fileSessions: Record<string, EditorSession>
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
  const cleanedSessions = cleanupSessionsForOpenedFiles(input.openedFiles, input.fileSessions)
  const meta: WorkspaceMeta = {
    expandedDirs: input.expandedDirs.map(normalizeDir),
    selectedPaths: input.selectedPaths.map(normalizeDir),
    noteOrder: noteOrderPlain,
    openedFiles: input.openedFiles.map(normalizeDir),
    activeFile: input.activeFileRelativePath || undefined,
    fileSessions: JSON.parse(JSON.stringify(cleanedSessions)),
  }
  return { cleanedSessions, meta }
}
