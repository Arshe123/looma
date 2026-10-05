import { reactive } from 'vue'
import type { AgentMemoryDocument, AgentMemoryInvalidation, AgentMemoryKind } from '../../../shared/types/agent-memory'
import type { Result } from '../../../shared/types/Result'
export interface MemoryAPI {
  read: (kind: AgentMemoryKind) => Promise<Result<AgentMemoryDocument>>
  save: (kind: AgentMemoryKind, content: string, revision: string) => Promise<Result<AgentMemoryDocument>>
  onChanged?: (listener: (event: AgentMemoryInvalidation) => void) => () => void
}
export function createMemoryEditor(kind: AgentMemoryKind, api: MemoryAPI) {
  let disposed = false
  let unsubscribe: (() => void) | undefined
  let generation = 0
  let pending = false
  let refreshing: Promise<void> | undefined
  const externalNotice = '内容已在其他窗口或对话更新；已保留你的编辑，请重新加载后合并。'
  const state = reactive({
    content: '', baseContent: '', revision: '', ready: false, busy: false, error: '', notice: '', invalidation: 0,
    async start() {
      if (disposed) return
      unsubscribe ??= api.onChanged?.(event => {
        if (disposed || event.kind !== kind) return
        generation++; state.invalidation++; pending = true
        void state.refresh()
      })
      await state.load()
    },
    dispose() { disposed = true; generation++; unsubscribe?.(); unsubscribe = undefined },
    // Serialize re-reads, coalescing notifications. An event is an invalidation,
    // never authoritative content; stale responses cannot change a draft.
    async refresh(): Promise<void> {
      if (disposed || state.busy) return
      if (refreshing) return refreshing
      refreshing = (async () => {
        while (pending && !disposed && !state.busy) {
          pending = false
          const ticket = generation
          try {
            const result = await api.read(kind)
            if (disposed || ticket !== generation || state.busy) continue
            if (!result.success || !result.data) throw new Error(result.error || '同步失败，请重新加载。')
            if (result.data.revision === state.revision) continue
            if (state.content !== state.baseContent) { state.notice = externalNotice; continue }
            state.accept(result.data)
            state.notice = '已同步最新内容，将在新对话中生效。'
          } catch (error) {
            if (!disposed && ticket === generation) state.error = error instanceof Error ? error.message : '同步失败，请重新加载。'
          }
        }
      })()
      try { await refreshing } finally { refreshing = undefined }
    },
    accept(document: AgentMemoryDocument, submitted = state.content) {
      if (disposed) return
      if (state.content === submitted) state.content = document.content
      state.baseContent = document.content; state.revision = document.revision; state.ready = true
    },
    beginWrite() { generation++; if (refreshing) pending = true; state.busy = true },
    async finishWrite() { state.busy = false; await state.refresh() },
    async load(discardEdits = false) {
      if (state.busy || disposed) return
      if (!discardEdits && state.content !== state.baseContent) {
        state.error = '有未保存的编辑，请先保存，或选择重新加载（丢弃编辑）。'
        return
      }
      state.busy = true
      generation++
      state.ready = false
      state.error = ''; state.notice = ''
      try {
        const submitted = state.content
        while (!disposed) {
          const ticket = generation
          pending = false
          const result = await api.read(kind)
          if (disposed) return
          if (ticket !== generation) continue
          if (!result.success || !result.data) throw new Error(result.error || '读取失败，请重试。')
          state.accept(result.data, submitted)
          break
        }
      } catch (error) { if (!disposed) state.error = error instanceof Error ? error.message : '读取失败，请重试。' }
      finally { state.busy = false }
    },
    async save() {
      if (!state.ready || state.busy || disposed) return
      state.beginWrite()
      state.error = ''; state.notice = ''
      const submitted = state.content
      try {
        const result = await api.save(kind, submitted, state.revision)
        if (disposed) return
        if (!result.success || !result.data) throw new Error(result.error || '保存失败，请重试。')
        state.accept(result.data, submitted)
        state.notice = '已保存，将在新对话中生效。'
      } catch (error) { if (!disposed) { state.invalidation++; state.error = error instanceof Error ? error.message : '保存失败，请重试。' } }
      finally { await state.finishWrite() }
    },
  })
  return state
}
