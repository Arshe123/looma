import { reactive } from 'vue'
import type { AgentMemoryDocument, UserProfileHistoryEntry, UserProfileHistoryPage } from '../../../shared/types/agent-memory'
import type { Result } from '../../../shared/types/Result'
import type { createMemoryEditor } from './memoryEditor'

export interface UserProfileHistoryAPI {
  listUserHistory: (cursor?: string) => Promise<Result<UserProfileHistoryPage>>
  readUserHistory: (id: string) => Promise<Result<UserProfileHistoryEntry>>
  restoreUserHistory: (id: string, revision: string) => Promise<Result<AgentMemoryDocument>>
}
export function createUserProfileHistory(editor: ReturnType<typeof createMemoryEditor>, api: UserProfileHistoryAPI) {
  const state = reactive({
    entries: [] as UserProfileHistoryPage['entries'], nextCursor: undefined as string | undefined,
    selected: null as UserProfileHistoryEntry | null, confirming: false, busy: false, loaded: false, error: '',
    async load(more = false) {
      if (state.busy) return
      state.busy = true; state.error = ''; state.confirming = false
      try {
        const result = await api.listUserHistory(more ? state.nextCursor : undefined)
        if (!result.success || !result.data) throw new Error(result.error || '历史版本读取失败，请重试。')
        state.entries = more ? [...state.entries, ...result.data.entries] : result.data.entries
        state.nextCursor = result.data.nextCursor
        state.loaded = true
        if (!more) state.selected = null
      } catch (error) { state.error = error instanceof Error ? error.message : '历史版本读取失败，请重试。' }
      finally { state.busy = false }
    },
    async select(id: string) {
      if (state.busy) return
      state.busy = true; state.error = ''; state.confirming = false; state.selected = null
      try {
        const result = await api.readUserHistory(id)
        if (!result.success || !result.data) throw new Error(result.error || '历史版本读取失败，请重试。')
        state.selected = result.data
      } catch (error) { state.error = error instanceof Error ? error.message : '历史版本读取失败，请重试。' }
      finally { state.busy = false }
    },
    requestRestore() {
      state.confirming = false
      if (state.busy || editor.busy || !editor.ready || !state.selected) return
      if (editor.content !== editor.baseContent) {
        state.error = '有未保存的编辑，请先保存，或重新加载丢弃编辑后再恢复。'
        return
      }
      state.error = ''; state.confirming = true
    },
    async restore() {
      if (!state.confirming || !state.selected || state.busy || editor.busy || !editor.ready) return
      // Recheck because edits/current revision can change while confirming.
      if (editor.content !== editor.baseContent) { state.requestRestore(); return }
      const id = state.selected.id
      state.confirming = false; state.busy = true; editor.busy = true; state.error = ''
      let restored = false
      try {
        const result = await api.restoreUserHistory(id, editor.revision)
        if (!result.success || !result.data) throw new Error(result.error || '恢复失败，请重试。')
        editor.content = result.data.content; editor.baseContent = result.data.content; editor.revision = result.data.revision
        editor.error = ''; editor.notice = '已恢复，将在新对话中生效。'
        restored = true
      } catch (error) { state.error = error instanceof Error ? error.message : '恢复失败，请重试。' }
      finally { state.busy = false; editor.busy = false }
      if (restored) await state.load()
    },
  })
  return state
}
