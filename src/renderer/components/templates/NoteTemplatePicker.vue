<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AlertCircle, FilePlus2, LoaderCircle, Plus, RefreshCw, Settings2 } from 'lucide-vue-next'
import { normalizeMarkdownFilename, renderNoteTemplate } from '@/shared/utils/note-template'
import type { UiNoteTemplate } from './note-template-ui-types'

const props = defineProps<{
  templates: UiNoteTemplate[]
  loading: boolean
  error: string
  actionError: string
  pendingTemplateId: string
}>()

const emit = defineEmits<{
  blank: []
  select: [template: UiNoteTemplate]
  invalid: [message: string]
  manage: []
  retry: []
}>()

const cardGrid = ref<HTMLElement | null>(null)
const disabled = computed(() => Boolean(props.pendingTemplateId))
const previewNow = ref(new Date())
const refreshPreviewNow = () => { previewNow.value = new Date() }
let previewTimer: ReturnType<typeof setInterval> | undefined

const variablesFor = (template: UiNoteTemplate): Record<string, string | number | boolean> =>
  Object.fromEntries(template.variables.map(variable => [variable.name, variable.value]))

const resultErrorText = (result: ReturnType<typeof renderNoteTemplate>) => {
  if (!('error' in result)) return ''
  return `${result.error.message}（位置 ${result.error.position + 1}）`
}

const previewFor = (template: UiNoteTemplate) => {
  const rendered = renderNoteTemplate(template.fileNameTemplate, variablesFor(template), previewNow.value)
  const normalized = rendered.ok ? normalizeMarkdownFilename(rendered.value) : rendered
  return normalized.ok
    ? { valid: true, text: normalized.value }
    : { valid: false, text: '文件名模板有误', detail: resultErrorText(normalized) }
}

const cards = () => Array.from(cardGrid.value?.querySelectorAll<HTMLButtonElement>('[data-template-card]') ?? [])

const focusCard = (current: HTMLButtonElement, offset: number) => {
  const available = cards()
  const index = available.indexOf(current)
  if (index < 0 || available.length === 0) return
  available[(index + offset + available.length) % available.length]?.focus()
}

const handleCardKeydown = (event: KeyboardEvent) => {
  const current = event.currentTarget as HTMLButtonElement
  const columns = window.matchMedia('(min-width: 768px)').matches ? 3 : 1
  let offset = 0
  if (event.key === 'ArrowRight') offset = 1
  else if (event.key === 'ArrowLeft') offset = -1
  else if (event.key === 'ArrowDown') offset = columns
  else if (event.key === 'ArrowUp') offset = -columns
  else if (event.key === 'Home') {
    event.preventDefault()
    cards()[0]?.focus()
    return
  } else if (event.key === 'End') {
    event.preventDefault()
    cards().at(-1)?.focus()
    return
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    current.click()
    return
  } else return
  event.preventDefault()
  focusCard(current, offset)
}

const selectTemplate = (template: UiNoteTemplate) => {
  if (disabled.value) return
  const preview = previewFor(template)
  if (!preview.valid) {
    emit('invalid', preview.detail || '文件名模板表达式有误。')
    return
  }
  emit('select', template)
}

const focusFirstCard = async () => {
  await nextTick()
  cards()[0]?.focus()
}

onMounted(() => {
  previewTimer = setInterval(refreshPreviewNow, 60_000)
  void focusFirstCard()
})
onBeforeUnmount(() => {
  if (previewTimer) clearInterval(previewTimer)
})
watch(() => props.loading, loading => {
  if (!loading) void focusFirstCard()
})

defineExpose({ focusFirstCard })
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div v-if="actionError" role="alert" class="mx-6 mt-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
      <AlertCircle :size="17" class="mt-0.5 shrink-0" />
      <span>{{ actionError }}</span>
    </div>

    <div v-if="error" role="alert" class="mx-6 mt-4 flex items-center justify-between gap-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
      <span class="flex items-start gap-2"><AlertCircle :size="17" class="mt-0.5 shrink-0" />{{ error }}</span>
      <button type="button" class="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 font-medium hover:bg-danger/10" @click="emit('retry')">
        <RefreshCw :size="14" />重试
      </button>
    </div>

    <div v-if="loading" class="flex flex-1 items-center justify-center gap-2 text-sm text-text-muted" aria-live="polite">
      <LoaderCircle :size="18" class="animate-spin" />正在加载模板…
    </div>

    <div v-else ref="cardGrid" class="min-h-0 flex-1 overflow-y-auto p-6">
      <div class="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
        <button
          data-template-card="blank"
          type="button"
          class="group min-h-36 rounded-2xl border border-dashed border-accent/60 bg-accent-soft/35 p-4 text-left transition hover:border-accent hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="disabled"
          @click="emit('blank')"
          @keydown="handleCardKeydown"
        >
          <span class="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent"><Plus :size="20" /></span>
          <span class="block text-sm font-semibold text-text-main">空白笔记</span>
          <span class="mt-1 block text-xs text-text-muted">手动输入文件名</span>
        </button>

        <button
          v-for="template in templates"
          :key="template.id"
          :data-template-card="template.id"
          type="button"
          class="group min-h-36 rounded-2xl border border-border-soft bg-panel-soft/65 p-4 text-left transition hover:border-accent/60 hover:bg-accent-soft/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="disabled"
          :aria-describedby="`template-preview-${template.id}`"
          @click="selectTemplate(template)"
          @keydown="handleCardKeydown"
        >
          <span class="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-panel text-accent shadow-sm">
            <LoaderCircle v-if="pendingTemplateId === template.id" :size="19" class="animate-spin" />
            <FilePlus2 v-else :size="19" />
          </span>
          <span class="block truncate text-sm font-semibold text-text-main">{{ template.name }}</span>
          <span :id="`template-preview-${template.id}`" class="mt-1 block truncate text-xs" :class="previewFor(template).valid ? 'text-text-muted' : 'text-danger'">
            {{ previewFor(template).text }}
          </span>
          <span class="mt-3 block text-[11px] text-text-subtle">{{ template.variables.length }} 个变量</span>
        </button>
      </div>

      <div v-if="templates.length === 0 && !error" class="mt-6 text-center text-xs text-text-subtle">没有更多模板</div>
    </div>

    <footer class="flex shrink-0 items-center justify-between border-t border-border-soft bg-panel-soft/70 px-6 py-3 text-xs text-text-subtle">
      <span>{{ pendingTemplateId ? '创建进行中，请稍候…' : 'Esc 关闭 · 单击模板立即创建' }}</span>
      <button type="button" class="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-text-muted hover:bg-panel hover:text-text-main disabled:opacity-50" :disabled="loading || Boolean(error) || disabled" @click="emit('manage')">
        <Settings2 :size="14" />管理模板
      </button>
    </footer>
  </div>
</template>
