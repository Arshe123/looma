import type { FileWorkspaceTab, SystemPageId, SystemWorkspaceTab, WorkspaceTab } from './workspace-types'
import { normalizeDir, remapByMoves, removePathsAndDescendants } from './workspace-utils'

export const FILE_TAB_PREFIX = 'file:'
export const SYSTEM_TAB_PREFIX = 'system:'

export const getFileTabId = (relativePath: string) => `${FILE_TAB_PREFIX}${normalizeDir(relativePath)}`
export const getSystemTabId = (page: SystemPageId) => `${SYSTEM_TAB_PREFIX}${page}`

export const createFileTab = (relativePath: string): FileWorkspaceTab => {
  const rel = normalizeDir(relativePath)
  return {
    id: getFileTabId(rel),
    kind: 'file',
    relativePath: rel,
  }
}

export const createSystemTab = (page: SystemPageId): SystemWorkspaceTab => ({
  id: getSystemTabId(page),
  kind: 'system',
  page,
})

export const normalizeWorkspaceTabs = (tabs: unknown): WorkspaceTab[] => {
  if (!Array.isArray(tabs)) return []

  const normalized: WorkspaceTab[] = []
  const seen = new Set<string>()

  for (const item of tabs) {
    if (!item || typeof item !== 'object') continue
    const tab = item as Partial<WorkspaceTab>

    let next: WorkspaceTab | null = null
    if (tab.kind === 'file' && typeof (tab as any).relativePath === 'string') {
      const rel = normalizeDir((tab as any).relativePath)
      if (rel) next = createFileTab(rel)
    } else if (tab.kind === 'system' && ((tab as any).page === 'settings' || (tab as any).page === 'rag-index')) {
      next = createSystemTab((tab as any).page)
    }

    if (!next || seen.has(next.id)) continue
    seen.add(next.id)
    normalized.push(next)
  }

  return normalized
}

export const createTabsFromOpenedFiles = (openedFiles: string[] = []) => {
  const seen = new Set<string>()
  return openedFiles
    .map(createFileTab)
    .filter((tab) => {
      if (!tab.relativePath || seen.has(tab.id)) return false
      seen.add(tab.id)
      return true
    })
}

export const getTabTitle = (tab: WorkspaceTab) => {
  if (tab.kind === 'system') {
    if (tab.page === 'settings') return '系统设置'
    if (tab.page === 'rag-index') return '索引库'
    return '系统页面'
  }

  const fileName = tab.relativePath.split('/').pop() || tab.relativePath
  const dotIndex = fileName.lastIndexOf('.')
  const ext = dotIndex > 0 && dotIndex < fileName.length - 1 ? fileName.slice(dotIndex) : ''
  return ext ? fileName.slice(0, -ext.length) : fileName
}

export const getFilePathsFromTabs = (tabs: WorkspaceTab[]) => tabs
  .filter((tab): tab is Extract<WorkspaceTab, { kind: 'file' }> => tab.kind === 'file')
  .map((tab) => tab.relativePath)

export const removeFileTabsByPaths = (tabs: WorkspaceTab[], removedPaths: string[]) => tabs.filter((tab) => {
  if (tab.kind !== 'file') return true
  return removePathsAndDescendants([tab.relativePath], removedPaths).length > 0
})

export const remapFileTabsByMoves = (tabs: WorkspaceTab[], items: { from: string; to: string }[]) => {
  const seen = new Set<string>()
  let changed = false
  const nextTabs: WorkspaceTab[] = []

  for (const tab of tabs) {
    if (tab.kind !== 'file') {
      if (!seen.has(tab.id)) {
        seen.add(tab.id)
        nextTabs.push(tab)
      }
      continue
    }

    const nextRel = remapByMoves(tab.relativePath, items)
    const nextTab = createFileTab(nextRel)
    if (nextTab.relativePath !== tab.relativePath || nextTab.id !== tab.id) changed = true
    if (seen.has(nextTab.id)) {
      changed = true
      continue
    }
    seen.add(nextTab.id)
    nextTabs.push(nextTab)
  }

  return { tabs: nextTabs, changed }
}
