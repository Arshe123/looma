import { describe, expect, it } from 'vitest'
import {
  createFileTab,
  createSystemTab,
  createTabsFromOpenedFiles,
  getFilePathsFromTabs,
  getFileTabId,
  getSystemTabId,
  normalizeWorkspaceTabs,
  remapFileTabsByMoves,
  removeFileTabsByPaths,
} from '../workspace-tab-utils'

describe('workspace tab utils', () => {
  it('creates stable file and system tab ids', () => {
    expect(getFileTabId('docs\\note.md')).toBe('file:docs/note.md')
    expect(getSystemTabId('settings')).toBe('system:settings')
    expect(getSystemTabId('ai-history')).toBe('system:ai-history')
    expect(getSystemTabId('agent-diff')).toBe('system:agent-diff')
    expect(createFileTab('docs/note.md')).toEqual({
      id: 'file:docs/note.md',
      kind: 'file',
      relativePath: 'docs/note.md',
    })
    expect(createSystemTab('settings')).toEqual({
      id: 'system:settings',
      kind: 'system',
      page: 'settings',
    })
    expect(createSystemTab('ai-history')).toEqual({
      id: 'system:ai-history',
      kind: 'system',
      page: 'ai-history',
    })
  })

  it('normalizes tabs and removes invalid or duplicate entries', () => {
    expect(normalizeWorkspaceTabs([
      { id: 'wrong', kind: 'file', relativePath: 'docs\\a.md' },
      { id: 'duplicate', kind: 'file', relativePath: 'docs/a.md' },
      { id: 'settings', kind: 'system', page: 'settings' },
      { id: 'ai-history', kind: 'system', page: 'ai-history' },
      { id: 'agent-diff', kind: 'system', page: 'agent-diff' },
      { id: 'unknown', kind: 'system', page: 'unknown' },
      null,
    ])).toEqual([
      { id: 'file:docs/a.md', kind: 'file', relativePath: 'docs/a.md' },
      { id: 'system:settings', kind: 'system', page: 'settings' },
      { id: 'system:ai-history', kind: 'system', page: 'ai-history' },
      { id: 'system:agent-diff', kind: 'system', page: 'agent-diff' },
    ])
  })

  it('migrates legacy opened files into file tabs', () => {
    const tabs = createTabsFromOpenedFiles(['a.md', 'a.md', 'dir\\b.txt'])
    expect(tabs).toEqual([
      { id: 'file:a.md', kind: 'file', relativePath: 'a.md' },
      { id: 'file:dir/b.txt', kind: 'file', relativePath: 'dir/b.txt' },
    ])
    expect(getFilePathsFromTabs(tabs)).toEqual(['a.md', 'dir/b.txt'])
  })

  it('removes file tabs by deleted parent path while preserving system tabs', () => {
    const tabs = [
      createFileTab('docs/a.md'),
      createFileTab('docs/nested/b.md'),
      createFileTab('other.md'),
      createSystemTab('settings'),
    ]

    expect(removeFileTabsByPaths(tabs, ['docs'])).toEqual([
      createFileTab('other.md'),
      createSystemTab('settings'),
    ])
  })

  it('remaps file tabs after moves and preserves system tabs', () => {
    const result = remapFileTabsByMoves([
      createFileTab('docs/a.md'),
      createSystemTab('settings'),
    ], [{ from: 'docs', to: 'notes' }])

    expect(result.changed).toBe(true)
    expect(result.tabs).toEqual([
      createFileTab('notes/a.md'),
      createSystemTab('settings'),
    ])
  })
})
