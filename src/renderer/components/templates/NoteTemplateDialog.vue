<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Settings2, X } from 'lucide-vue-next'
import NoteTemplateManager from './NoteTemplateManager.vue'
import NoteTemplatePicker from './NoteTemplatePicker.vue'
import { getNoteTemplatesApi, type UiNoteTemplate, type UiNoteTemplateStore } from './note-template-ui-types'

type View = 'picker' | 'manager'

const props = defineProps<{
  open: boolean
  workspaceId: string
  parentDirRelativePath: string
}>()

const emit = defineEmits<{
  close: []
  blank: []
  created: [relativePath: string]
}>()

const view = ref<View>('picker')
const store = ref<UiNoteTemplateStore>({ schemaVersion: 1, revision: 0, templates: [] })
const loading = ref(false)
const loadError = ref('')
const actionError = ref('')
const technicalError = ref('')
const pendingTemplateId = ref('')
const pickerRef = ref<InstanceType<typeof NoteTemplatePicker> | null>(null)
const managerRef = ref<InstanceType<typeof NoteTemplateManager> | null>(null)
const noteTemplatesApi = getNoteTemplatesApi()

const loadTemplates = async () => {
  loading.value = true
  loadError.value = ''
  technicalError.value = ''
  try {
    const result = await noteTemplatesApi.list()
    if (!result.success || !result.data) {
      loadError.value = result.error || '模板加载失败。'
      technicalError.value = result.errorCode || ''
      return
    }
    store.value = result.data
  } catch (error) {
    loadError.value = '模板加载失败。'
    technicalError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

const requestClose = async () => {
  if (pendingTemplateId.value) return
  if (view.value === 'manager' && managerRef.value && !await managerRef.value.confirmDiscard()) return
  emit('close')
}

const chooseBlank = () => {
  if (pendingTemplateId.value) return
  emit('close')
  emit('blank')
}

const instantiate = async (template: UiNoteTemplate) => {
  if (pendingTemplateId.value) return
  pendingTemplateId.value = template.id
  actionError.value = ''
  technicalError.value = ''
  try {
    const result = await noteTemplatesApi.instantiate({
      workspaceId: props.workspaceId,
      parentDirRelativePath: props.parentDirRelativePath,
      templateId: template.id,
    })
    if (!result.success) {
      actionError.value = result.error || '创建笔记失败。'
      technicalError.value = result.errorCode || ''
      if (result.errorCode === 'TEMPLATE_STATE_COMMIT_PARTIAL' && result.data) {
        emit('created', result.data.relativePath)
      }
      if (result.errorCode === 'TEMPLATE_STALE' || result.errorCode === 'TEMPLATE_NOT_FOUND') {
        await loadTemplates()
      }
      return
    }
    if (!result.data) {
      actionError.value = '创建笔记失败：主进程未返回文件路径。'
      return
    }
    emit('created', result.data.relativePath)
    emit('close')
  } catch (error) {
    actionError.value = '创建笔记失败。'
    technicalError.value = error instanceof Error ? error.message : String(error)
  } finally {
    pendingTemplateId.value = ''
  }
}

const openManager = () => {
  actionError.value = ''
  view.value = 'manager'
}

const handleInvalidTemplate = (message: string) => {
  actionError.value = message || '模板表达式有误，请在模板管理中修正。'
}

const backToPicker = async () => {
  if (managerRef.value && !await managerRef.value.confirmDiscard()) return
  view.value = 'picker'
  await loadTemplates()
  await nextTick()
  pickerRef.value?.focusFirstCard()
}

const handleStoreUpdated = (nextStore: UiNoteTemplateStore) => {
  store.value = nextStore
}

const handleKeydown = (event: KeyboardEvent) => {
  if (!props.open || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  requestClose()
}

watch(() => props.open, async open => {
  if (!open) return
  view.value = 'picker'
  actionError.value = ''
  pendingTemplateId.value = ''
  await loadTemplates()
}, { immediate: true })

if (typeof window !== 'undefined') window.addEventListener('keydown', handleKeydown, true)
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', handleKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-[70] flex items-end justify-center bg-overlay p-0 backdrop-blur-sm md:items-center md:p-5" role="presentation" @mousedown.self="requestClose">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-template-title"
        class="flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-t-[1.75rem] border border-border-soft bg-panel shadow-2xl md:max-h-[88vh] md:rounded-[1.75rem]"
        :class="view === 'manager' ? 'md:max-w-5xl' : 'md:max-w-3xl'"
        @keydown.stop
      >
        <header class="flex shrink-0 items-start justify-between gap-4 border-b border-border-soft bg-panel-soft/80 px-6 py-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h2 id="note-template-title" class="text-lg font-bold tracking-[-0.03em] text-text-main">
                {{ view === 'manager' ? '管理模板' : '新建笔记' }}
              </h2>
              <span v-if="view === 'manager'" class="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent">全局</span>
            </div>
            <p v-if="view === 'picker'" class="mt-1 truncate text-xs text-text-muted">
              将创建到：{{ parentDirRelativePath || '工作空间根目录' }}
            </p>
            <p v-else class="mt-1 text-xs text-text-muted">模板在所有工作空间中共用。</p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button v-if="view === 'picker'" type="button" class="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-xs font-medium text-text-muted hover:bg-panel hover:text-text-main" :disabled="loading || Boolean(loadError)" @click="view = 'manager'">
              <Settings2 :size="15" />管理模板
            </button>
            <button type="button" aria-label="关闭" class="flex h-9 w-9 items-center justify-center rounded-xl text-text-muted hover:bg-panel hover:text-text-main" @click="requestClose">
              <X :size="18" />
            </button>
          </div>
        </header>

        <NoteTemplatePicker
          v-if="view === 'picker'"
          ref="pickerRef"
          :templates="store.templates"
          :loading="loading"
          :error="loadError"
          :action-error="actionError"
          :pending-template-id="pendingTemplateId"
          @blank="chooseBlank"
          @select="instantiate"
          @invalid="handleInvalidTemplate"
          @manage="openManager"
          @retry="loadTemplates"
        />
        <NoteTemplateManager
          v-else
          ref="managerRef"
          :store="store"
          @updated="handleStoreUpdated"
          @back="backToPicker"
          @close="requestClose"
        />

        <details v-if="technicalError" class="shrink-0 border-t border-border-soft bg-panel-soft px-6 py-2 text-xs text-text-subtle">
          <summary class="cursor-pointer select-none">技术详情</summary>
          <p class="mt-2 break-all font-mono">{{ technicalError }}</p>
        </details>
      </section>
    </div>
  </Teleport>
</template>
