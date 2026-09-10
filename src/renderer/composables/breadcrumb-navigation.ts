import { computed, onScopeDispose, ref, watch } from 'vue'
import type { FsEntry } from '@/renderer/stores/workspace-types'

type NavigationOptions = {
  workspaceId: () => string | null
  currentFile: () => string
  listDirectory: (workspaceId: string, relativePath: string) => Promise<FsEntry[]>
  openFile: (relativePath: string) => void
  onError: (message: string) => void
}

export function useBreadcrumbNavigation(options: NavigationOptions) {
  const browsingPath = ref<string | null>(null)
  const entries = ref<FsEntry[]>([])
  const loading = ref(false)
  const focusByFile = ref<Record<string, string>>({})
  const focusLabel = computed(() => focusByFile.value[options.currentFile()] || '')
  let requestId = 0
  const cancel = () => {
    requestId++
    browsingPath.value = null
    entries.value = []
    loading.value = false
  }
  const browse = async (relativePath: string) => {
    const workspace = options.workspaceId()
    if (!workspace) return
    const request = ++requestId
    browsingPath.value = relativePath
    entries.value = []
    loading.value = true
    try {
      const result = await options.listDirectory(workspace, relativePath)
      if (request === requestId) entries.value = result
    } catch {
      if (request !== requestId) return
      cancel()
      options.onError(`无法读取文件夹“${relativePath || '工作空间'}”，请确认目录存在且有访问权限。`)
    } finally {
      if (request === requestId) loading.value = false
    }
  }
  const choose = async (entry: FsEntry) => {
    if (entry.isDirectory) return browse(entry.relativePath)
    cancel()
    options.openFile(entry.relativePath)
  }
  const updateFocus = (focus: { relativePath: string; label: string }) => {
    if (!focus.relativePath || focus.relativePath !== options.currentFile()) return
    focusByFile.value[focus.relativePath] = focus.label
    cancel()
  }
  watch(options.workspaceId, () => { focusByFile.value = {} }, { flush: 'sync' })
  watch([options.workspaceId, options.currentFile], cancel, { flush: 'sync' })
  onScopeDispose(cancel)
  return { browsingPath, entries, loading, focusLabel, browse, choose, cancel, updateFocus }
}

export type Breadcrumb = { name: string; relativePath: string; isDirectory: boolean }

export function buildBreadcrumbs(workspaceName: string, relativePath: string, directory: boolean): Breadcrumb[] {
  const parts = relativePath ? relativePath.split('/') : []
  return [
    { name: workspaceName, relativePath: '', isDirectory: true },
    ...parts.map((name, index) => ({
      name,
      relativePath: parts.slice(0, index + 1).join('/'),
      isDirectory: directory || index < parts.length - 1,
    })),
  ]
}
