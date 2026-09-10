import { describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { buildBreadcrumbs, useBreadcrumbNavigation } from '../breadcrumb-navigation'
import type { FsEntry } from '@/renderer/stores/workspace-types'

const entry = (relativePath: string, isDirectory = false): FsEntry => ({
  name: relativePath.split('/').pop()!, relativePath, isDirectory, size: 0, mtimeMs: 0, birthtimeMs: 0,
})
const setup = (listDirectory = vi.fn(async (_workspace: string, path: string) => [entry(`${path}/child`, true)])) => {
  const scope = effectScope()
  const workspaceId = ref<string | null>('workspace')
  const currentFile = ref('notes/active.md')
  const openFile = vi.fn()
  const onError = vi.fn()
  const nav = scope.run(() => useBreadcrumbNavigation({
    workspaceId: () => workspaceId.value, currentFile: () => currentFile.value,
    listDirectory, openFile, onError,
  }))!
  return { scope, workspaceId, currentFile, openFile, onError, nav, listDirectory }
}

describe('breadcrumb navigation', () => {
  it('discards directory responses after cancellation, another folder, tab switch or workspace switch', async () => {
    const pending: Array<(entries: FsEntry[]) => void> = []
    const list = vi.fn((_workspace: string, _path: string) => new Promise<FsEntry[]>(resolve => pending.push(resolve)))
    const { nav, currentFile, workspaceId, scope } = setup(list)
    const first = nav.browse('first')
    const second = nav.browse('second')
    pending[1]([entry('second/note.md')])
    await second
    pending[0]([entry('first/stale.md')])
    await first
    expect(nav.entries.value.map(e => e.relativePath)).toEqual(['second/note.md'])

    const cancelled = nav.browse('cancelled')
    nav.cancel()
    pending[2]([entry('cancelled/stale.md')])
    await cancelled
    expect(nav.entries.value).toEqual([])
    expect(nav.browsingPath.value).toBeNull()

    const switched = nav.browse('switch')
    currentFile.value = 'another.md'
    pending[3]([entry('switch/stale.md')])
    await switched
    expect(nav.browsingPath.value).toBeNull()
    expect(nav.entries.value).toEqual([])

    const workspaceSwitch = nav.browse('old')
    workspaceId.value = 'another-workspace'
    pending[4]([entry('old/stale.md')])
    await workspaceSwitch
    expect(nav.browsingPath.value).toBeNull()
    expect(nav.entries.value).toEqual([])

    const disposed = nav.browse('unmounted')
    scope.stop()
    pending[5]([entry('unmounted/stale.md')])
    await disposed
    expect(nav.entries.value).toEqual([])
  })

  it('reports current read failures without opening a file and ignores stale failures', async () => {
    const list = vi.fn(async (_workspace: string, _path: string): Promise<FsEntry[]> => { throw new Error('permission denied') })
    const { nav, onError, openFile, scope } = setup(list)
    await nav.browse('private')
    expect(onError).toHaveBeenCalledWith('无法读取文件夹“private”，请确认目录存在且有访问权限。')
    expect(nav.loading.value).toBe(false)
    expect(nav.browsingPath.value).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
    onError.mockClear()
    const stale = nav.browse('old')
    nav.cancel()
    await stale
    expect(onError).not.toHaveBeenCalled()
    scope.stop()
  })

  it('restores the active note focus on an editor click, ignoring background editors', async () => {
    const { nav, currentFile, workspaceId, scope } = setup()
    nav.updateFocus({ relativePath: currentFile.value, label: '设计目标' })
    await nav.browse('research')
    nav.updateFocus({ relativePath: 'background.md', label: '后台内容' })
    expect(nav.browsingPath.value).toBe('research')
    nav.updateFocus({ relativePath: currentFile.value, label: '设计目标' })
    expect(nav.browsingPath.value).toBeNull()
    expect(nav.focusLabel.value).toBe('设计目标')
    currentFile.value = 'new.md'
    expect(nav.focusLabel.value).toBe('')
    currentFile.value = 'notes/active.md'
    expect(nav.focusLabel.value).toBe('设计目标')
    workspaceId.value = 'different-workspace'
    expect(nav.focusLabel.value).toBe('')
    scope.stop()
  })

  it('extends a temporary folder path without opening files until a file is selected', async () => {
    const { nav, openFile, scope } = setup()
    await nav.browse('research')
    expect(nav.browsingPath.value).toBe('research')
    expect(nav.entries.value[0].relativePath).toBe('research/child')
    await nav.choose(nav.entries.value[0])
    expect(nav.browsingPath.value).toBe('research/child')
    expect(openFile).not.toHaveBeenCalled()
    await nav.choose(entry('research/child/note.md'))
    expect(openFile).toHaveBeenCalledWith('research/child/note.md')
    expect(nav.browsingPath.value).toBeNull()
    scope.stop()
  })
})

describe('buildBreadcrumbs', () => {
  it('builds clickable ancestors and a file endpoint, preserving Chinese names', () => {
    expect(buildBreadcrumbs('我的笔记', '产品设计/交互探索/导航.md', false)).toEqual([
      { name: '我的笔记', relativePath: '', isDirectory: true },
      { name: '产品设计', relativePath: '产品设计', isDirectory: true },
      { name: '交互探索', relativePath: '产品设计/交互探索', isDirectory: true },
      { name: '导航.md', relativePath: '产品设计/交互探索/导航.md', isDirectory: false },
    ])
  })
})
