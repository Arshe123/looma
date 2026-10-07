import { reactive, watch } from 'vue'
import type { MemoryCleanupPreview, MemoryCleanupSelection } from '../../../shared/types/agent-memory'
import type { Result } from '../../../shared/types/Result'
export interface MemoryCleanupAPI {
  previewCleanup(selection: MemoryCleanupSelection): Promise<Result<MemoryCleanupPreview>>
  cleanup(selection: MemoryCleanupSelection, token: string): Promise<Result<void>>
}
export function createMemoryCleanup(api: MemoryCleanupAPI, cleared: (selection: MemoryCleanupSelection) => void) {
  let disposed = false
  let generation = 0
  const state = reactive({
    selection: { history: true, snapshots: false, user: false } as MemoryCleanupSelection,
    preview: null as MemoryCleanupPreview | null,
    confirmed: false, busy: false, error: '', notice: '',
    async inspect() {
      if (disposed || state.busy) return
      const ticket = generation
      state.busy = true; state.preview = null; state.confirmed = false; state.error = ''; state.notice = ''
      try {
        const result = await api.previewCleanup({ ...state.selection })
        if (disposed || ticket !== generation) return
        if (!result.success || !result.data) throw new Error(result.error || '清理预览失败，请重试。')
        state.preview = result.data
      } catch (error) { state.error = error instanceof Error ? error.message : '清理预览失败，请重试。' }
      finally { state.busy = false }
    },
    async apply() {
      if (disposed || state.busy || !state.confirmed || !state.preview) return
      const { selection, token } = state.preview
      state.busy = true; state.confirmed = false; state.error = ''; state.notice = ''
      try {
        const result = await api.cleanup({ ...selection }, token)
        if (!result.success) throw new Error(result.error || '清理未完成，请重新预览后检查。')
        cleared(selection)
        if (!disposed) state.notice = '所选本机记忆已清理。旧聊天和其中的记忆更新详情仍保留，请新建对话；自动维护设置未改变。'
      } catch (error) { if (!disposed) state.error = error instanceof Error ? error.message : '清理未完成，请重新预览后检查。' }
      finally { state.busy = false; state.preview = null }
    },
    dispose() { disposed = true; generation++; stop() },
  })
  const stop = watch(() => ({ ...state.selection }), () => {
    generation++; state.preview = null; state.confirmed = false; state.notice = ''
    if (state.selection.user) { state.selection.history = true; state.selection.snapshots = true }
  }, { flush: 'sync' })
  return state
}
