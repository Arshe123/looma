<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Search } from 'lucide-vue-next'
import { useWorkspaceStore } from '../store/workspace'

const workspaceStore = useWorkspaceStore()
const inputRef = ref<HTMLInputElement | null>(null)
const activeIndex = ref(0)

const query = computed({
  get: () => workspaceStore.commandPaletteQuery,
  set: (v: string) => (workspaceStore.commandPaletteQuery = v),
})

type CommandItem = { id: string; title: string; shortcut: string; run: () => void | Promise<void> }

const commands = computed<CommandItem[]>(() => [
  {
    id: 'workspace.switch',
    title: '打开工作空间（新窗口）…',
    shortcut: 'Ctrl+O',
    run: () => workspaceStore.openWorkspaceInNewWindowFlow(),
  },
  {
    id: 'workspace.new',
    title: '新建工作空间（新窗口）…',
    shortcut: 'Ctrl+Shift+N',
    run: () => workspaceStore.newWorkspaceInNewWindowFlow(),
  },
])

const filtered = computed(() => {
  const q = (query.value || '').trim().toLowerCase()
  if (!q) return commands.value
  return commands.value.filter((c) => c.title.toLowerCase().includes(q))
})

const close = () => workspaceStore.closeCommandPalette()

const runActive = async () => {
  const item = filtered.value[activeIndex.value]
  if (!item) return
  close()
  await item.run()
}

const onKeyDown = (e: KeyboardEvent) => {
  if (!workspaceStore.commandPaletteOpen) return
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (!filtered.value.length) return
    activeIndex.value = (activeIndex.value + 1) % filtered.value.length
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (!filtered.value.length) return
    activeIndex.value = (activeIndex.value - 1 + filtered.value.length) % filtered.value.length
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    runActive()
  }
}

watch(
  () => workspaceStore.commandPaletteOpen,
  async (open) => {
    if (!open) {
      activeIndex.value = 0
      return
    }
    await nextTick()
    inputRef.value?.focus()
    inputRef.value?.select()
  },
)

watch(
  () => query.value,
  () => {
    activeIndex.value = 0
  },
)

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div v-if="workspaceStore.commandPaletteOpen" class="fixed inset-0 z-50 bg-black/40 flex items-start justify-center pt-20" @pointerdown.self="close">
    <div class="w-[720px] max-w-[92vw] rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden" @pointerdown.stop>
      <div class="flex items-center gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <Search :size="18" class="text-zinc-400" />
        <input
          ref="inputRef"
          v-model="query"
          class="flex-1 bg-transparent outline-none text-sm text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400"
          placeholder="键入命令"
        />
        <div class="text-[11px] text-zinc-400">Esc</div>
      </div>

      <div class="max-h-[360px] overflow-y-auto">
        <button
          v-for="(c, idx) in filtered"
          :key="c.id"
          class="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
          :class="[idx === activeIndex ? 'bg-zinc-100 dark:bg-zinc-800' : '']"
          @mouseenter="activeIndex = idx"
          @click="() => { activeIndex = idx; runActive() }"
        >
          <div class="text-sm text-zinc-800 dark:text-zinc-100">{{ c.title }}</div>
          <div class="text-[11px] text-zinc-400">{{ c.shortcut }}</div>
        </button>

        <div v-if="filtered.length === 0" class="px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400">无匹配命令</div>
      </div>
    </div>
  </div>
</template>
