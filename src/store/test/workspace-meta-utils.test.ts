import { describe, expect, it } from 'vitest'
import { buildWorkspaceMetaPayload } from '../workspace-meta-utils'
import { createFileTab, createSystemTab } from '../workspace-tab-utils'

describe('buildWorkspaceMetaPayload tab persistence', () => {
  it('persists unified tabs and writes legacy openedFiles for compatibility', () => {
    const tabs = [createFileTab('docs/a.md'), createSystemTab('settings')]

    const { cleanedSessions, meta } = buildWorkspaceMetaPayload({
      expandedDirs: ['docs'],
      selectedPaths: ['docs/a.md'],
      noteOrder: {},
      openedFiles: ['legacy.md'],
      activeFileRelativePath: 'docs/a.md',
      tabs,
      activeTabId: 'system:settings',
      fileSessions: {
        'docs/a.md': { updatedAt: 1 },
        'legacy.md': { updatedAt: 2 },
      },
      activeSidebarPanel: 'files',
    })

    expect(meta.tabs).toEqual(tabs)
    expect(meta.activeTabId).toBe('system:settings')
    expect(meta.openedFiles).toEqual(['docs/a.md'])
    expect(meta.activeFile).toBe('docs/a.md')
    expect(cleanedSessions).toEqual({
      'docs/a.md': { updatedAt: 1 },
    })
  })

  it('falls back to legacy openedFiles when unified tabs are absent', () => {
    const { meta } = buildWorkspaceMetaPayload({
      expandedDirs: [],
      selectedPaths: [],
      noteOrder: {},
      openedFiles: ['legacy.md'],
      activeFileRelativePath: 'legacy.md',
      fileSessions: {},
      activeSidebarPanel: null,
    })

    expect(meta.tabs).toBeUndefined()
    expect(meta.activeTabId).toBeUndefined()
    expect(meta.openedFiles).toEqual(['legacy.md'])
  })
})
