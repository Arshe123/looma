import { reactive } from 'vue'
import type { AgentMemoryDocument, AgentMemoryKind } from '../../../shared/types/agent-memory'
import type { Result } from '../../../shared/types/Result'
export interface MemoryAPI {
  read: (kind: AgentMemoryKind) => Promise<Result<AgentMemoryDocument>>
  save: (kind: AgentMemoryKind, content: string, revision: string) => Promise<Result<AgentMemoryDocument>>
}
export function createMemoryEditor(kind: AgentMemoryKind, api: MemoryAPI) {
  const state = reactive({
    content: '', revision: '', ready: false, busy: false, error: '', notice: '',
    async load() {
      if (state.busy) return
      state.busy = true
      state.ready = false
      state.error = ''; state.notice = ''
      try {
        const result = await api.read(kind)
        if (!result.success || !result.data) throw new Error(result.error || '读取失败，请重试。')
        state.content = result.data.content
        state.revision = result.data.revision
        state.ready = true
      } catch (error) { state.error = error instanceof Error ? error.message : '读取失败，请重试。' }
      finally { state.busy = false }
    },
    async save() {
      if (!state.ready || state.busy) return
      state.busy = true
      state.error = ''; state.notice = ''
      try {
        const result = await api.save(kind, state.content, state.revision)
        if (!result.success || !result.data) throw new Error(result.error || '保存失败，请重试。')
        state.revision = result.data.revision
        state.notice = '已保存，将在新对话中生效。'
      } catch (error) { state.error = error instanceof Error ? error.message : '保存失败，请重试。' }
      finally { state.busy = false }
    },
  })
  return state
}
