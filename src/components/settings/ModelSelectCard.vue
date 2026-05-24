<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Check,
  ChevronDown,
  Download,
  HardDrive,
  Loader2,
  Search,
  Trash2,
} from 'lucide-vue-next'

export interface ModelOption {
  name: string
  installed: boolean
  selected: boolean
  desc: string
  size?: string
}

const props = defineProps<{
  title: string
  subtitle: string
  modelValue: string
  options: ModelOption[]
  open: boolean
  needsPull: boolean
  isPulling: boolean
  isModelPulling?: (model: string) => boolean
  isModelDeleting?: (model: string) => boolean
}>()

const emit = defineEmits<{
  (event: 'update:open', value: boolean): void
  (event: 'select', model: string): void
  (event: 'pull', model: string, selectAfterPull?: boolean): void
  (event: 'delete', model: string): void
}>()

const searchQuery = ref('')

const trimmedSearchQuery = computed(() => searchQuery.value.trim())

const selectedOption = computed(() => {
  return props.options.find((option) => option.name === props.modelValue)
})

const selectedDescription = computed(() => {
  return selectedOption.value?.desc ?? '已安装的本地模型'
})

const filteredOptions = computed(() => {
  const query = trimmedSearchQuery.value.toLowerCase()
  if (!query) return props.options
  return props.options.filter((option) => option.name.toLowerCase().includes(query))
})

const canPullSearchQuery = computed(() => {
  const model = trimmedSearchQuery.value
  return Boolean(model && !filteredOptions.value.length && !isOptionPulling(model))
})

const toggleOpen = () => {
  emit('update:open', !props.open)
}

const selectModel = (model: string) => {
  emit('select', model)
}

const isOptionPulling = (model: string) => {
  return props.isModelPulling?.(model) ?? (model === props.modelValue && props.isPulling)
}

const pullModel = (model: string, selectAfterPull = true) => {
  emit('pull', model, selectAfterPull)
}

const pullSearchQueryModel = () => {
  if (!canPullSearchQuery.value) return
  pullModel(trimmedSearchQuery.value, false)
}

const isOptionDeleting = (model: string) => {
  return props.isModelDeleting?.(model) ?? false
}

const deleteModel = (model: string) => {
  emit('delete', model)
}

watch(
  () => props.open,
  (open) => {
    if (!open) searchQuery.value = ''
  }
)
</script>

<template>
  <div class="relative grid min-w-0 gap-2">
    <div class="flex items-center justify-between gap-3">
      <span class="text-xs font-medium text-text-main">{{ title }}</span>
      <span class="text-[10px] text-text-subtle">{{ subtitle }}</span>
    </div>
    <div>
      <button
        type="button"
        class="w-full min-w-0 rounded-2xl border px-3 py-3 text-left transition-colors"
        :class="open ? 'border-accent/40 bg-accent-soft/50 shadow-sm' : 'border-border-soft bg-panel hover:bg-accent-soft/40'"
        @click="toggleOpen"
      >
        <div class="flex min-w-0 items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-3">
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border-soft bg-panel-soft text-text-muted">
              <HardDrive :size="15" />
            </span>
            <span class="min-w-0">
              <span class="flex min-w-0 items-center gap-2">
                <span class="truncate text-sm font-semibold text-text-main">{{ modelValue || '未选择模型' }}</span>
                <span
                  class="inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[10px] font-medium"
                  :class="needsPull ? 'border-danger/20 bg-danger/10 text-danger' : 'border-success/20 bg-success/10 text-success'"
                >
                  {{ needsPull ? '未下载' : '已安装' }}
                </span>
              </span>
              <span class="mt-1 block truncate text-[11px] text-text-muted">
                {{ selectedDescription }}
              </span>
            </span>
          </div>
          <ChevronDown
            :size="16"
            class="shrink-0 text-text-muted transition-transform"
            :class="open ? 'rotate-180' : ''"
          />
        </div>
      </button>
    </div>

    <div
      v-if="open"
      class="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-border-soft bg-panel shadow-2xl"
    >
      <div class="border-b border-border-soft bg-panel-soft p-3">
        <label class="flex h-9 items-center gap-2 rounded-xl border border-border-soft bg-panel px-3 focus-within:border-accent">
          <Search :size="14" class="shrink-0 text-text-subtle" />
          <input
            v-model="searchQuery"
            class="min-w-0 flex-1 bg-transparent text-xs text-text-main outline-none placeholder:text-text-subtle"
            placeholder="搜索模型..."
            spellcheck="false"
            @keydown.enter.prevent="pullSearchQueryModel"
          />
        </label>
      </div>
      <div class="max-h-[360px] overflow-y-auto p-2">
        <button
          v-for="option in filteredOptions"
          :key="option.name"
          type="button"
        class="group mb-1 flex w-full min-w-0 items-start justify-between gap-3 rounded-2xl border px-3 py-3 text-left transition-colors"
          :class="option.selected ? 'border-accent/50 bg-accent-soft/60' : 'border-transparent bg-panel hover:border-border-soft hover:bg-panel-soft'"
          @click="selectModel(option.name)"
        >
          <span class="flex min-w-0 items-start gap-3">
            <span
              class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border"
              :class="option.selected ? 'border-accent/30 bg-panel' : 'border-border-soft bg-panel-soft'"
            >
              <Check v-if="option.selected" :size="15" class="text-success" />
              <HardDrive v-else-if="option.installed" :size="15" class="text-text-muted" />
              <Download v-else :size="15" class="text-danger" />
            </span>
            <span class="min-w-0">
              <span class="flex min-w-0 items-center gap-2">
                <span class="truncate text-xs font-semibold text-text-main">{{ option.name }}</span>
              </span>
              <span class="mt-1 line-clamp-2 text-[11px] leading-4 text-text-muted">{{ option.desc }}</span>
              <span v-if="option.size" class="mt-1 block text-[10px] text-text-subtle">{{ option.size }}</span>
            </span>
          </span>
          <span class="flex shrink-0 flex-col items-end gap-1">
            <span
              v-if="option.installed"
              class="rounded-full border border-success/20 bg-success/10 px-2 py-1 text-[10px] font-medium text-success"
            >
              已下载
            </span>
            <button
              v-if="option.installed"
              type="button"
              class="inline-flex h-7 items-center justify-center gap-1 rounded-lg border border-danger/20 bg-danger/10 px-2 text-[10px] font-medium text-danger transition-colors hover:border-danger/40 hover:bg-danger/15 disabled:cursor-not-allowed disabled:border-border-soft disabled:bg-panel-soft disabled:text-text-subtle"
              :disabled="isOptionDeleting(option.name) || isOptionPulling(option.name)"
              @click.stop="deleteModel(option.name)"
            >
              <Loader2 v-if="isOptionDeleting(option.name)" :size="12" class="animate-spin" />
              <Trash2 v-else :size="12" />
              <span>{{ isOptionDeleting(option.name) ? '删除中' : '删除' }}</span>
            </button>
            <button
              v-else
              type="button"
              class="inline-flex h-7 items-center justify-center gap-1 rounded-lg border border-accent/20 bg-accent-soft px-2 text-[10px] font-medium text-accent transition-colors hover:border-accent/40 hover:bg-accent-soft/80 disabled:cursor-not-allowed disabled:border-border-soft disabled:bg-panel-soft disabled:text-text-subtle"
              :disabled="isOptionPulling(option.name)"
              @click.stop="pullModel(option.name, true)"
            >
              <Loader2 v-if="isOptionPulling(option.name)" :size="12" class="animate-spin" />
              <Download v-else :size="12" />
              <span>{{ isOptionPulling(option.name) ? '下载中' : '下载' }}</span>
            </button>
          </span>
        </button>
        <div v-if="!filteredOptions.length" class="rounded-xl bg-panel-soft px-3 py-4 text-center text-xs text-text-muted">
          <template v-if="trimmedSearchQuery">
            <div class="font-medium text-text-main">没有匹配的模型</div>
            <div class="mt-1">按 Enter 下载「{{ trimmedSearchQuery }}」</div>
            <button
              type="button"
              class="mt-3 inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-accent/20 bg-accent-soft px-3 text-xs font-medium text-accent transition-colors hover:border-accent/40 hover:bg-accent-soft/80 disabled:cursor-not-allowed disabled:border-border-soft disabled:bg-panel disabled:text-text-subtle"
              :disabled="!canPullSearchQuery"
              @click="pullSearchQueryModel"
            >
              <Loader2 v-if="isOptionPulling(trimmedSearchQuery)" :size="12" class="animate-spin" />
              <Download v-else :size="12" />
              <span>{{ isOptionPulling(trimmedSearchQuery) ? '下载中' : '下载当前名称' }}</span>
            </button>
          </template>
          <template v-else>
            没有匹配的模型
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
