import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ExternalDocumentData } from '@/shared/types/external-document'
import type { EditorSession } from './workspace-types'

export interface ExternalEditorDocument extends ExternalDocumentData {
  pending: boolean
  saving: boolean
  error: string
  recoveryError: string
  session?: EditorSession
}
export const useExternalDocumentsStore = defineStore('externalDocuments', () => {
  const documents = ref<ExternalEditorDocument[]>([])
  const activeId = ref<string | null>(null)
  const transferring = ref(false)
  const flushers = new Map<string, () => void>()
  const queues = new Map<string, Promise<unknown>>()
  const closing = new Set<string>()
  const get = (id: string) => documents.value.find(doc => doc.id === id)
  const api = () => window.electronAPI.externalDocuments
  const serial = <T>(id: string, operation: () => Promise<T>) => {
    const next = (queues.get(id) || Promise.resolve()).then(operation, operation)
    queues.set(id, next.catch(() => {}))
    return next
  }
  const dirty = (id: string) => {
    const doc = get(id)
    return Boolean(doc && (doc.pending || doc.content !== doc.baseContent))
  }
  function open(input: ExternalDocumentData) {
    if (!get(input.id)) documents.value.push({ ...input, pending: false, saving: false, error: '', recoveryError: '' })
    activeId.value = input.id
  }
  async function persistDraft(id: string) {
    const doc = get(id)
    if (!doc) return
    try {
      await api().draft(id, doc.content, doc.baseContent)
      doc.recoveryError = ''
    } catch { doc.recoveryError = '恢复草稿暂时无法保存；原文件保存仍可使用。' }
  }
  function update(id: string, content: string) {
    const doc = get(id)
    if (!doc) return
    doc.content = content
    doc.pending = false
    void serial(id, () => persistDraft(id))
  }
  function markPending(id: string) {
    const doc = get(id)
    if (doc) doc.pending = true
  }
  function registerFlush(id: string, flush?: () => void) {
    if (flush) flushers.set(id, flush)
    else flushers.delete(id)
  }
  async function save(id: string, explicit = false) {
    return serial(id, async () => {
      const doc = get(id)
      if (!doc || closing.has(id) || doc.pending) return false
      if (doc.content === doc.baseContent) return true
      if (doc.error && !explicit) return false
      const content = doc.content
      let expected = doc.baseContent
      doc.saving = true
      try {
        if (explicit && doc.error) {
          const disk = await api().readCurrent(id)
          if (disk !== expected) {
            const result = await window.electronAPI.app.showMessageBox({ type: 'warning', message: '文件已被其他程序修改', detail: '覆盖会替换磁盘内容。取消可保留当前编辑与恢复草稿。', buttons: ['覆盖磁盘内容', '取消'], defaultId: 1, cancelId: 1 })
            if (result.response !== 0) return false
            expected = disk
          }
        }
        await api().save(id, content, expected)
        doc.baseContent = content
        doc.error = ''
        await persistDraft(id)
        return true
      } catch (error) {
        doc.error = `保存失败：${error instanceof Error ? error.message : String(error)}`
        return false
      } finally { doc.saving = false }
    })
  }
  async function close(id: string) {
    if (transferring.value || closing.has(id)) return false
    flushers.get(id)?.()
    await queues.get(id)
    const doc = get(id)
    if (!doc) return true
    if (dirty(id)) {
      const result = await window.electronAPI.app.showMessageBox({ type: 'question', message: '保存外部文件的更改？', detail: doc.filePath, buttons: ['保存', '不保存', '取消'], defaultId: 0, cancelId: 2 })
      if (result.response === 2) return false
      if (result.response === 0) {
        if (!await save(id, true)) return false
        flushers.get(id)?.()
        if (dirty(id)) return false
      }
    }
    closing.add(id)
    try {
      await serial(id, () => api().close(id))
      documents.value = documents.value.filter(item => item.id !== id)
      flushers.delete(id)
      queues.delete(id)
      if (activeId.value === id) activeId.value = documents.value.at(-1)?.id || null
      return true
    } catch (error) {
      doc.error = String(error)
      return false
    } finally { closing.delete(id) }
  }
  async function closeAll() {
    for (const doc of [...documents.value]) if (!await close(doc.id)) return false
    return true
  }
  async function transferCurrent(workspaceId: string) {
    const id = activeId.value
    if (!id || transferring.value) return false
    const doc = get(id)
    if (!doc) return false
    transferring.value = true
    closing.add(id) // Suppress queued autosaves, never force-save during a handoff.
    try {
      flushers.get(id)?.()
      await queues.get(id)
      flushers.get(id)?.()
      await queues.get(id)
      if (doc.pending) throw new Error('编辑内容尚未准备完成')
      await api().transfer(workspaceId, id, doc.content, doc.baseContent)
      documents.value = documents.value.filter(item => item.id !== id)
      flushers.delete(id)
      queues.delete(id)
      if (activeId.value === id) activeId.value = documents.value.at(-1)?.id || null
      return true
    } catch (error) {
      doc.error = `打开工作空间未完成：${String(error)}`
      return false
    } finally { closing.delete(id); transferring.value = false }
  }
  return { documents, activeId, transferring, transferCurrent, open, update, dirty, markPending, registerFlush, save, close, closeAll }
})
