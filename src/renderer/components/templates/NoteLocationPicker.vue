<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { ChevronDown, ChevronRight, Folder } from 'lucide-vue-next'

const props = defineProps<{ workspaceId: string; modelValue: string; disabled: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [path: string] }>()
type Directory = { name: string; relativePath: string }
const trigger = ref<HTMLButtonElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const open = ref(false)
const children = ref<Record<string, Directory[]>>({})
const expanded = ref(new Set<string>())
const loading = ref(new Set<string>())
const errors = ref<Record<string, string>>({})
const position = ref({ left: '0px', top: '0px', width: '320px', maxHeight: '320px' })
let generation = 0
const rows = computed(() => {
  const result: Array<Directory & { depth: number }> = []
  const visit = (directory: Directory, depth: number) => {
    result.push({ ...directory, depth })
    if (expanded.value.has(directory.relativePath)) {
      for (const child of children.value[directory.relativePath] || []) visit(child, depth + 1)
    }
  }
  visit({ name: '工作空间根目录', relativePath: '' }, 0)
  return result
})
const load = async (path: string) => {
  if (children.value[path] || loading.value.has(path)) return
  const current = generation
  loading.value.add(path)
  delete errors.value[path]
  try {
    const result = await window.electronAPI.fs.listDir(props.workspaceId, path || '.')
    if (current !== generation) return
    if (!result.success || !result.data) throw new Error(result.error || '文件夹加载失败，请重试。')
    children.value[path] = result.data.filter(item => item.isDirectory && !item.name.startsWith('.'))
  } catch {
    if (current === generation) errors.value[path] = '文件夹加载失败，请重试。'
  } finally {
    if (current === generation) loading.value.delete(path)
  }
}
const close = (restoreFocus = false) => {
  if (!open.value) return false
  open.value = false
  generation++
  if (restoreFocus) trigger.value?.focus()
  return true
}
const toggle = async () => {
  if (close() || props.disabled) return
  const rect = trigger.value!.getBoundingClientRect()
  const width = Math.min(360, window.innerWidth - 24)
  position.value = {
    left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
    top: `${rect.bottom + 6}px`, width: `${width}px`,
    maxHeight: `${Math.max(80, Math.min(320, window.innerHeight - rect.bottom - 18))}px`,
  }
  children.value = {}
  loading.value = new Set()
  errors.value = {}
  expanded.value = new Set([''])
  open.value = true
  const current = generation
  await load('')
  const parts = props.modelValue.split('/').filter(Boolean)
  let ancestor = ''
  for (const part of parts) {
    if (current !== generation) return
    ancestor = ancestor ? `${ancestor}/${part}` : part
    expanded.value.add(ancestor)
    await load(ancestor)
  }
  await nextTick()
  if (current === generation) {
    const selected = menu.value?.querySelector<HTMLButtonElement>('[aria-selected="true"] button[data-location-select]')
    selected?.focus()
    selected?.scrollIntoView({ block: 'nearest' })
  }
}
const toggleFolder = async (path: string) => {
  if (expanded.value.has(path)) expanded.value.delete(path)
  else { expanded.value.add(path); await load(path) }
}
const choose = (path: string) => {
  if (props.disabled) return
  emit('update:modelValue', path)
  close(true)
}
const outside = (event: PointerEvent) => {
  if (event.target instanceof Node && !trigger.value?.contains(event.target) && !menu.value?.contains(event.target)) close()
}
const resize = () => { close() }
window.addEventListener('pointerdown', outside)
window.addEventListener('resize', resize)
onBeforeUnmount(() => {
  generation++
  window.removeEventListener('pointerdown', outside)
  window.removeEventListener('resize', resize)
})
defineExpose({ close })
</script>

<template>
  <button ref="trigger" type="button" aria-label="选择笔记新建位置" aria-haspopup="tree" :aria-expanded="open" :disabled="disabled"
    class="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border-soft bg-panel px-2 py-1.5 text-xs text-text-muted hover:border-accent disabled:opacity-50"
    :title="modelValue || '工作空间根目录'" @click="toggle">
    <Folder :size="14" class="shrink-0" /><span class="shrink-0">将创建到：</span>
    <span class="truncate">{{ modelValue || '工作空间根目录' }}</span><ChevronDown :size="14" class="shrink-0" />
  </button>
  <Teleport to="body">
    <div v-if="open" ref="menu" role="tree" aria-label="笔记位置文件夹" :style="position"
      class="fixed z-[80] overflow-auto rounded-xl border border-border-soft bg-panel p-1.5 shadow-xl" @keydown.esc.stop.prevent="close(true)">
      <template v-for="row in rows" :key="row.relativePath">
        <div role="treeitem" :aria-level="row.depth + 1" :aria-selected="modelValue === row.relativePath"
          :aria-expanded="expanded.has(row.relativePath)" :style="{ paddingLeft: `${row.depth * 16}px` }"
          class="flex items-center rounded-lg text-xs" :class="modelValue === row.relativePath ? 'bg-accent-soft text-accent' : 'text-text-main hover:bg-panel-soft'">
          <button type="button" class="shrink-0 rounded p-1.5" :aria-label="`${expanded.has(row.relativePath) ? '折叠' : '展开'}${row.name}`" @click="toggleFolder(row.relativePath)">
            <ChevronRight :size="14" :class="{ 'rotate-90': expanded.has(row.relativePath) }" />
          </button>
          <button type="button" data-location-select :data-location-path="row.relativePath" :title="row.relativePath || row.name" class="flex min-w-0 flex-1 items-center gap-2 py-2 pr-2 text-left" @click="choose(row.relativePath)">
            <Folder :size="14" class="shrink-0" /><span class="truncate">{{ row.name }}</span>
          </button>
        </div>
        <p v-if="loading.has(row.relativePath)" class="px-4 py-1 text-xs text-text-muted" role="status">正在加载…</p>
        <button v-if="errors[row.relativePath]" type="button" class="px-4 py-1 text-xs text-danger" @click="load(row.relativePath)">{{ errors[row.relativePath] }}</button>
      </template>
    </div>
  </Teleport>
</template>
