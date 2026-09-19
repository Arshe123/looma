<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import MarkdownEditor from './editor/MarkdownEditor.vue'
import { useExternalDocumentsStore, type ExternalEditorDocument } from '@/renderer/stores/externalDocuments'
import type { DocumentSession } from './editor/documentSession'
import { useSettingsStore } from '@/renderer/stores/settings'
import { matchesAppShortcut } from '@/shared/utils/app-shortcuts'

const store = useExternalDocumentsStore()
const settings = useSettingsStore()
const explanation = ref(localStorage.getItem('looma.externalDocuments.explained') !== '1')
const editors = new Map<string, InstanceType<typeof MarkdownEditor>>()
const sessions = new Map<string, DocumentSession>()
function sessionFor(doc: ExternalEditorDocument) {
  if (!sessions.has(doc.id)) sessions.set(doc.id, {
    getSession: () => doc.session,
    saveSession: value => { doc.session = { ...value, updatedAt: Date.now() } },
  })
  return sessions.get(doc.id)!
}
function setEditor(id: string, editor: unknown) {
  if (editor) {
    editors.set(id, editor as InstanceType<typeof MarkdownEditor>)
    store.registerFlush(id, () => editors.get(id)?.flushPendingContent())
  } else {
    editors.delete(id)
    sessions.delete(id)
    store.registerFlush(id)
  }
}
function dismiss() {
  explanation.value = false
  localStorage.setItem('looma.externalDocuments.explained', '1')
}
function save(id: string) {
  editors.get(id)?.flushPendingContent()
  void store.save(id, true)
}
function keydown(event: KeyboardEvent) {
  if (store.activeId && matchesAppShortcut(event, settings.appShortcuts.saveFile, window.electronAPI.platform)) {
    event.preventDefault()
    event.stopImmediatePropagation()
    save(store.activeId)
  }
}
onMounted(() => window.addEventListener('keydown', keydown, true))
onUnmounted(() => window.removeEventListener('keydown', keydown, true))
</script>

<template>
  <section v-show="store.activeId" class="flex flex-col flex-1 min-h-0" aria-label="外部文件编辑器">
    <div v-if="explanation" class="px-4 py-2 text-xs text-text-muted bg-accent-soft flex items-center gap-3">
      <span>外部文件会自动保存到原位置，不会导入工作空间，也不会加入搜索、索引或 AI 上下文。异常退出草稿仅保存在应用数据目录。</span>
      <button class="shrink-0 text-accent" @click="dismiss">知道了</button>
    </div>
    <div v-for="doc in store.documents" :key="doc.id" v-show="store.activeId === doc.id" class="flex flex-col flex-1 min-h-0" :data-external-document="doc.id">
      <div v-if="doc.error || doc.recoveryError" role="alert" class="text-sm px-4 py-2 text-red-500">
        {{ doc.error || doc.recoveryError }}
        <button class="underline ml-3" @click="save(doc.id)">重新保存</button>
      </div>
      <div class="flex-1 min-h-0">
        <MarkdownEditor :ref="editor => setEditor(doc.id, editor)" :document-session="sessionFor(doc)"
          :file-path="doc.filePath" relative-file-path="" :content="doc.content" :save-trigger="0"
          :is-partial="false" :is-loading="false" :is-loading-more="false" :total-bytes="0" :use-chunked-preview="false"
          @update:content="content => store.update(doc.id, content)"
          @edit-pending="store.markPending(doc.id)"
          @save="content => { store.update(doc.id, content); store.save(doc.id) }" />
      </div>
    </div>
  </section>
</template>
