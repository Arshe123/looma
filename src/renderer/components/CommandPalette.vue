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
    title: '打开工作空间',
    shortcut: 'Ctrl+O',
    run: () => workspaceStore.openWorkspaceInNewWindowFlow(),
  },
  {
    id: 'workspace.new',
    title: '新建工作空间',
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
  <div
    v-if="workspaceStore.commandPaletteOpen"
    class="fixed inset-0 z-50 bg-overlay flex items-start justify-center pt-20"
    @pointerdown.self="close"
  >
    <div
      class="w-[720px] max-w-[92vw] rounded-xl bg-panel border border-border-soft shadow-2xl shadow-black/25 overflow-hidden"
      @pointerdown.stop
    >
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border-soft">
        <Search :size="18" class="text-text-subtle" />
        <input
          ref="inputRef"
          v-model="query"
          class="flex-1 bg-transparent outline-hidden text-sm text-text-main placeholder:text-text-subtle"
          placeholder="搜索命令…"
        />
        <div class="text-[11px] text-text-subtle">Esc</div>
      </div>

      <div class="max-h-[360px] overflow-y-auto focus-scrollbar">
        <button
          v-for="(c, idx) in filtered"
          :key="c.id"
          class="w-full px-4 py-3 flex items-center justify-between text-left text-text-main hover:bg-accent-soft"
          :class="[idx === activeIndex ? 'bg-accent-soft' : '']"
          @mouseenter="activeIndex = idx"
          @click="() => { activeIndex = idx; runActive() }"
        >
          <div class="text-sm">{{ c.title }}</div>
          <div class="text-[11px] text-text-subtle">{{ c.shortcut }}</div>
        </button>

        <div v-if="filtered.length === 0" class="px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400">无匹配命令</div>
      </div>
    </div>
  </div>
</template>
