<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FileText, Search } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import { buildNoteRefRelativePath } from '@/shared/utils/note-link-ref'

const props = defineProps<{
  /** 当前笔记相对路径，用于计算插入的相对引用路径 */
  fromRelativePath: string
  /** 触发时是否把当前选中文本作为链接文字 */
  selectedText?: string
}>()

const emit = defineEmits<{
  (e: 'select', payload: { relativePath: string; href: string; label: string }): void
  (e: 'close'): void
}>()

const workspaceStore = useWorkspaceStore()
const open = ref(true)
const query = ref('')
const notes = ref<string[]>([])
const loading = ref(true)
const error = ref('')
const selectedIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)

const filteredNotes = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return notes.value
  return notes.value.filter((path) => path.toLowerCase().includes(q))
})

const loadNotes = async () => {
  const workspaceId = workspaceStore.activeWorkspaceId
  if (!workspaceId) return
  loading.value = true
  error.value = ''
  const result = await window.electronAPI.fs.listNotes(workspaceId)
  loading.value = false
  if (!result.success || !result.data) {
    error.value = result.error || '加载笔记列表失败'
    return
  }
  notes.value = result.data
}

const labelOf = (path: string) => {
  const base = path.split('/').pop() || path
  return base.replace(/\.(md|txt)$/i, '')
}

const selectNote = (relativePath: string) => {
  const href = buildNoteRefRelativePath(props.fromRelativePath, relativePath)
  const label = props.selectedText?.trim() || labelOf(relativePath)
  emit('select', { relativePath, href, label })
}

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    selectedIndex.value = Math.min(selectedIndex.value + 1, filteredNotes.value.length - 1)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0)
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    const note = filteredNotes.value[selectedIndex.value]
    if (note) selectNote(note)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}

watch(query, () => {
  selectedIndex.value = 0
})

watch(filteredNotes, (items) => {
  if (selectedIndex.value >= items.length) selectedIndex.value = Math.max(0, items.length - 1)
})

onMounted(async () => {
  await loadNotes()
  await nextTick()
  inputRef.value?.focus()
})

onBeforeUnmount(() => {
  open.value = false
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[9998]"
      @mousedown.self="emit('close')"
    >
      <div class="absolute left-1/2 top-24 w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl border border-border-soft bg-panel shadow-2xl overflow-hidden">
        <div class="flex items-center gap-2 border-b border-border-soft px-3 py-2">
          <Search :size="15" class="shrink-0 text-text-muted" />
          <input
            ref="inputRef"
            v-model="query"
            class="w-full bg-transparent text-sm text-text-main outline-none placeholder:text-text-muted"
            placeholder="搜索笔记（输入关键字过滤，Enter 选择）"
            @keydown="onKeydown"
          />
        </div>
        <div class="max-h-72 overflow-y-auto focus-scrollbar py-1">
          <div v-if="loading" class="px-4 py-3 text-sm text-text-muted">加载笔记列表...</div>
          <div v-else-if="error" class="px-4 py-3 text-sm text-text-muted">{{ error }}</div>
          <div v-else-if="filteredNotes.length === 0" class="px-4 py-3 text-sm text-text-muted">
            没有找到笔记{{ query.trim() ? `（关键字：${query.trim()}）` : '' }}
          </div>
          <button
            v-for="(note, index) in filteredNotes"
            :key="note"
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors"
            :class="index === selectedIndex ? 'bg-accent-soft text-accent' : 'text-text-main hover:bg-accent-soft/50'"
            @click="selectNote(note)"
            @mouseenter="selectedIndex = index"
          >
            <FileText :size="15" class="shrink-0 text-text-muted" />
            <span class="min-w-0 flex-1 truncate">{{ labelOf(note) }}</span>
            <span class="shrink-0 truncate text-xs text-text-muted">{{ note }}</span>
          </button>
        </div>
        <div class="border-t border-border-soft px-3 py-1.5 text-[11px] text-text-muted">
          输入 <b>[[</b> 或从菜单插入笔记引用 · ↑↓ 选择 · Enter 确认 · Esc 关闭
        </div>
      </div>
    </div>
  </Teleport>
</template>
