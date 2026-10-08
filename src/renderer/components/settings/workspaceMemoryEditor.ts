import { reactive } from 'vue'
import type { AgentMemoryInvalidation, WorkspaceMemoryAPI } from '../../../shared/types/agent-memory'
import { createMemoryEditor, type MemoryAPI } from './memoryEditor'
import type { UserProfileHistoryAPI } from './userProfileHistory'
import type { MemoryCleanupAPI } from './memoryCleanup'

export function createWorkspaceMemoryEditor(api: WorkspaceMemoryAPI, subscribe: NonNullable<MemoryAPI['onChanged']>) {
  type Binding = { workspaceId: string; name: string; editor: ReturnType<typeof createMemoryEditor>; api: MemoryAPI & UserProfileHistoryAPI & MemoryCleanupAPI; enabled: boolean; settingReady: boolean; settingBusy: boolean; settingError: string; setEnabled: (enabled: boolean) => Promise<void> }
  let ticket = 0, disposed = false
  let stop: (() => void) | undefined
  const drafts = new Map<string, ReturnType<typeof createMemoryEditor>>()
  const state = reactive({
    current: null as Binding | null, loading: false, error: '',
    async switchWorkspace(expectedId: string | null) {
      const generation = ++ticket
      if (state.current) {
        drafts.set(state.current.workspaceId, state.current.editor)
        state.current.editor.dispose()
      }
      stop?.(); stop = undefined
      state.current = null; state.error = ''; state.loading = false
      if (disposed || !expectedId) return
      state.loading = true
      try {
        const result = await api.context()
        if (disposed || generation !== ticket) return
        if (!result.success) throw new Error(result.error || '工作空间信息读取失败。')
        if (!result.data || result.data.workspaceId !== expectedId) throw new Error('当前工作空间已变化，请重新加载；未显示其他空间记忆。')
        const { workspaceId, name } = result.data
        const scoped: Binding['api'] = {
          read: () => api.read(workspaceId),
          save: (_kind, content, revision) => api.save(workspaceId, content, revision),
          onChanged: listener => subscribe(event => {
            if (event.kind === 'workspace' && event.workspaceId === workspaceId && !event.maintenance) listener({ ...event, kind: 'user' })
          }),
          listUserHistory: cursor => api.listHistory(workspaceId, cursor),
          readUserHistory: id => api.readHistory(workspaceId, id),
          restoreUserHistory: (id, revision) => api.restoreHistory(workspaceId, id, revision),
          previewCleanup: selection => api.previewCleanup(workspaceId, selection),
          cleanup: async (selection, token) => {
            const result = await api.cleanup(workspaceId, selection, token)
            if (result.success && selection.user) {
              // Clear only the draft whose deletion was confirmed, never the
              // newly active workspace if this request finishes after a switch.
              drafts.delete(workspaceId)
              if (!disposed && generation === ticket) await editor.load(true)
            }
            return result
          },
        }
        const editor = createMemoryEditor('user', scoped)
        const draft = drafts.get(workspaceId)
        if (draft && draft.content !== draft.baseContent) Object.assign(editor, {
          content: draft.content, baseContent: draft.baseContent, revision: draft.revision, ready: draft.ready,
          notice: '已保留此工作空间未保存的编辑；保存时仍会检查原版本。',
        })
        let settingGeneration = 0
        const binding: Binding = reactive({ workspaceId, name, editor, api: scoped, enabled: false, settingReady: false, settingBusy: false, settingError: '',
          async setEnabled(enabled: boolean) {
            if (generation !== ticket || binding.settingBusy || !binding.settingReady) return
            binding.settingBusy = true; binding.settingError = ''; settingGeneration++
            try {
              const result = await api.setMaintenance(workspaceId, enabled)
              if (!result.success) throw new Error(result.error || '设置保存失败。')
            } catch (error) { if (generation === ticket) binding.settingError = error instanceof Error ? error.message : '设置保存失败。' }
            finally { binding.settingBusy = false; if (generation === ticket) await refreshSetting() }
          },
        })
        const refreshSetting = async () => {
          const request = ++settingGeneration
          try {
            const result = await api.readMaintenance(workspaceId)
            if (disposed || generation !== ticket || request !== settingGeneration || binding.settingBusy) return
            if (!result.success || typeof result.data !== 'boolean') throw new Error(result.error || '设置读取失败。')
            binding.enabled = result.data; binding.settingReady = true
          } catch (error) { if (generation === ticket && request === settingGeneration) { binding.settingReady = false; binding.settingError = error instanceof Error ? error.message : '设置读取失败。' } }
        }
        stop = subscribe((event: AgentMemoryInvalidation) => {
          if (event.kind === 'workspace' && event.workspaceId === workspaceId && event.maintenance) void refreshSetting()
        })
        state.current = binding
        await Promise.all([editor.start(), refreshSetting()])
      } catch (error) { if (!disposed && generation === ticket) state.error = error instanceof Error ? error.message : '工作空间记忆读取失败。' }
      finally { if (generation === ticket) state.loading = false }
    },
    dispose() { disposed = true; ticket++; state.current?.editor.dispose(); stop?.(); stop = undefined; drafts.clear() },
  })
  return state
}
