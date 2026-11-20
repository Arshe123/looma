import { computed, effectScope, onScopeDispose, ref, shallowRef, watch, type EffectScope } from 'vue'
import { defineStore } from 'pinia'
import { useWorkspaceStore } from './workspace'
import { useKnowledgeGraphViewStore } from './knowledge-graph-view'
import { KnowledgeGraphLoader } from '@/renderer/services/knowledge-graph-loader'
import { buildGraphEdges, parseGraphNote, type GraphNote } from '@/shared/utils/knowledge-graph'
import { resolveWorkspaceFilePath } from '@/shared/utils/main-content-routing'

export interface NoteRelationSummary { outgoing: number; incoming: number }

/** One lazy workspace scan shared by title metadata and the graph panel. */
export const useNoteRelationsStore = defineStore('note-relations', () => {
  const workspace = useWorkspaceStore()
  const loader = new KnowledgeGraphLoader()
  const diskNotes = shallowRef<GraphNote[]>([])
  const draftNotes = shallowRef(new Map<string, GraphNote>())
  const loading = ref(false)
  const error = ref('')
  const loaded = ref(false)
  const progress = ref({ done: 0, total: 0 })
  const notes = computed(() => diskNotes.value.map(note => draftNotes.value.has(note.path)
    ? { ...draftNotes.value.get(note.path)!, createdAt: note.createdAt } : note))
  const graph = computed(() => buildGraphEdges(notes.value))
  const noteByPath = computed(() => new Map(notes.value.map(note => [note.path, note])))
  const summaries = computed(() => {
    const result = new Map(notes.value.map(note => [note.path, { outgoing: 0, incoming: 0 }]))
    // buildGraphEdges already collapses repeated citations to a directed note pair.
    for (const edge of graph.value.edges) {
      result.get(edge.source)!.outgoing++
      result.get(edge.target)!.incoming++
    }
    return result
  })
  const draftCache = new Map<string, { content: string; note: GraphNote }>()
  let scope: EffectScope | undefined
  let unsubscribe: (() => void) | undefined
  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  let draftTimer: ReturnType<typeof setTimeout> | undefined
  let requestId = 0
  let pending: Promise<void> | undefined

  function summary(path: string): NoteRelationSummary | null {
    if (!loaded.value || error.value || noteByPath.value.get(path)?.error) return null
    return summaries.value.get(path) || null
  }

  function updateDrafts() {
    const overrides = new Map<string, GraphNote>()
    for (const [path, state] of Object.entries(workspace.openedTextFileContents)) {
      if (state.isPartial || state.isLoading || !/\.(md|txt)$/i.test(path)) continue
      let cached = draftCache.get(path)
      if (!cached || cached.content !== state.content) {
        cached = { content: state.content, note: parseGraphNote(path, state.content) }
        draftCache.set(path, cached)
      }
      overrides.set(path, cached.note)
    }
    for (const path of draftCache.keys()) if (!overrides.has(path)) draftCache.delete(path)
    draftNotes.value = overrides
  }

  function load(): Promise<void> {
    const ws = workspace.activeWorkspace
    const id = ++requestId
    if (!ws) { loading.value = false; return Promise.resolve() }
    loading.value = true
    error.value = ''
    progress.value = { done: 0, total: 0 }
    const current = () => id === requestId && ws.id === workspace.activeWorkspaceId
    const task = (async () => {
      try {
        const result = await loader.load({
          list: () => window.electronAPI.fs.listNotes(ws.id, { watchDirectories: true, includeCreatedAt: true }),
          read: path => window.electronAPI.file.readMarkdown(resolveWorkspaceFilePath(ws.path, path)),
        }, (done, total) => { if (current()) progress.value = { done, total } })
        if (!result || !current()) return
        diskNotes.value = result
        updateDrafts()
        loaded.value = true
      } catch (cause) {
        if (current()) error.value = cause instanceof Error ? cause.message : '图谱加载失败'
      } finally {
        if (current()) { loading.value = false; pending = undefined }
      }
    })()
    pending = task
    return task
  }

  function reset() {
    ++requestId
    loader.invalidate()
    clearTimeout(reloadTimer)
    clearTimeout(draftTimer)
    reloadTimer = draftTimer = undefined
    pending = undefined
    diskNotes.value = []
    draftNotes.value = new Map()
    draftCache.clear()
    loaded.value = false
    loading.value = false
    error.value = ''
    progress.value = { done: 0, total: 0 }
  }

  function start() {
    if (scope) return
    scope = effectScope(true)
    scope.run(() => {
      watch(() => workspace.activeWorkspaceId, () => { reset(); subscribe(); void load() }, { immediate: true, flush: 'sync' })
      watch(() => Object.entries(workspace.openedTextFileContents).map(([path, state]) => [path, state.content, state.isPartial, state.isLoading]), () => {
        clearTimeout(draftTimer)
        draftTimer = setTimeout(updateDrafts, 180)
      })
    })
  }

  function subscribe() {
    if (unsubscribe || !workspace.activeWorkspaceId || typeof window === 'undefined') return
    unsubscribe = window.electronAPI?.fs?.onEvent?.(event => {
      if (event.workspaceId !== workspace.activeWorkspaceId) return
      if (!/\.(md|txt)$/i.test(event.relativePath) && event.event !== 'addDir' && event.event !== 'unlinkDir') return
      ++requestId
      loader.invalidate(event.relativePath.replace(/\\/g, '/'))
      pending = undefined
      if (event.event === 'addDir') void window.electronAPI.fs.watchAdd?.(event.workspaceId, [event.relativePath]).catch(() => {})
      clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => { reloadTimer = undefined; void load() }, 300)
    })
  }

  function ensureLoaded(): Promise<void> {
    start()
    subscribe()
    if (pending) return pending
    if (reloadTimer !== undefined) { clearTimeout(reloadTimer); reloadTimer = undefined; return load() }
    return loaded.value && !error.value ? Promise.resolve() : load()
  }

  function refresh(): Promise<void> {
    start()
    clearTimeout(reloadTimer)
    reloadTimer = undefined
    loader.invalidate()
    return load()
  }

  function stop() {
    scope?.stop()
    scope = undefined
    unsubscribe?.()
    unsubscribe = undefined
    reset()
  }
  onScopeDispose(stop)

  function open(path: string): Promise<void> {
    const id = workspace.activeWorkspaceId
    if (!id || !path) return Promise.resolve()
    const view = useKnowledgeGraphViewStore().forWorkspace(id)
    view.selectedPath = path
    view.focused = true
    view.query = ''
    view.requestedPath = path
    view.requestToken++
    workspace.setActiveAuxiliaryPanel('graph')
    return ensureLoaded()
  }

  return { notes, graph, loaded, loading, error, progress, summary, ensureLoaded, start, stop, refresh, open }
})
