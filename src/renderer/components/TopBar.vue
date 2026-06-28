<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Minus, Square, X, ChevronDown, FolderOpen, Plus, Command } from 'lucide-vue-next'
import { useWorkspaceStore } from '../stores/workspace'

const workspaceStore = useWorkspaceStore()

const workspaceName = computed(() => workspaceStore.activeWorkspace?.name || '未打开工作空间')
const recentWorkspaces = computed(() => {
  const active = workspaceStore.activeWorkspaceId
  return workspaceStore.workspaces
    .filter((w) => w.id !== active)
    .slice()
    .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
    .slice(0, 10)
})

const menuOpen = ref(false)

const closeMenu = () => {
  menuOpen.value = false
}

const toggleMenu = () => {
  menuOpen.value = !menuOpen.value
}

const onSwitchTo = async (id: string) => {
  closeMenu()
  await workspaceStore.openWorkspaceInNewWindow(id)
}

const minimizeWindow = () => {
  ;(window as any).electronAPI?.window?.minimize?.()
}

const toggleMaximizeWindow = () => {
  ;(window as any).electronAPI?.window?.toggleMaximize?.()
}

const closeWindow = async () => {
  if (workspaceStore.isWorkspaceTransitioning) return
  workspaceStore.setWorkspaceTransition(true, '姝ｅ湪淇濆瓨...')
  const ok = await workspaceStore.ensureSavedBeforeWorkspaceChange()
  if (!ok) {
    workspaceStore.setWorkspaceTransition(false, '')
    return
  }
  try {
    await workspaceStore.saveWorkspaceMeta()
  } catch {}
  // Intentionally don't clear transitioning flag so the app stays blocked until it closes
  await (window as any).electronAPI?.window?.close?.()
}

let cleanupPrepareClose: (() => void) | null = null
let cleanupWorkspaceMenu: (() => void) | null = null

onMounted(() => {
  if ((window as any).electronAPI?.window?.onPrepareClose) {
    cleanupPrepareClose = (window as any).electronAPI.window.onPrepareClose(() => {
      closeWindow()
    })
  }

  const onPointerDown = (e: PointerEvent) => {
    const el = e.target as HTMLElement | null
    if (!el) return
    if (el.closest('[data-workspace-menu]')) return
    closeMenu()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeMenu()
  }

  window.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('keydown', onKeyDown)

  cleanupWorkspaceMenu = () => {
    window.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('keydown', onKeyDown)
  }
})

onUnmounted(() => {
  if (cleanupPrepareClose) cleanupPrepareClose()
  if (cleanupWorkspaceMenu) cleanupWorkspaceMenu()
})
</script>

<template>
  <header class="h-12 w-full" style="-webkit-app-region: drag">
    <div class="h-full flex items-center justify-between gap-3 px-2">
      <div class="flex items-center gap-2 min-w-0" style="-webkit-app-region: no-drag">
        <div class="relative" data-workspace-menu>
          <button
            class="h-9 px-3 rounded-lg bg-panel/70 hover:bg-panel-soft flex items-center gap-2 min-w-0 cursor-pointer"
            :title="workspaceStore.activeWorkspace?.path || ''"
            @click="toggleMenu"
            style="-webkit-app-region: no-drag"
          >
            <span class="truncate text-sm font-semibold text-text-main">
              {{ workspaceName }}
            </span>
            <ChevronDown :size="16" class="text-text-muted shrink-0" />
          </button>

          <div
            v-if="menuOpen"
            class="absolute left-0 mt-2 w-[420px] max-w-[80vw] rounded-xl border border-border-soft bg-panel shadow-2xl overflow-hidden z-50"
            style="-webkit-app-region: no-drag"
            @pointerdown.stop
          >
            <div class="px-3 py-2 text-[11px] font-semibold text-text-muted border-b border-border-soft">
              最近打开
            </div>

            <div v-if="recentWorkspaces.length === 0" class="px-3 py-3 text-sm text-text-muted">
              暂无历史记录
            </div>

            <button
              v-for="ws in recentWorkspaces"
              :key="ws.id"
              class="w-full px-3 py-2 text-left hover:bg-accent-soft"
              @click="onSwitchTo(ws.id)"
            >
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-sm font-medium text-text-main truncate">{{ ws.name }}</div>
                  <div class="text-[11px] text-text-muted truncate">{{ ws.path }}</div>
                </div>
              </div>
            </button>

            <div class="border-t border-border-soft"></div>

            <button
              class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft flex items-center justify-between"
              @click="() => { closeMenu(); workspaceStore.openWorkspaceInNewWindowFlow() }"
            >
              <span class="inline-flex items-center gap-2 text-text-main">
                <FolderOpen :size="16" class="text-text-muted" />
                打开工作空间
              </span>
              <span class="text-[11px] text-text-subtle">Ctrl+O</span>
            </button>

            <button
              class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft flex items-center justify-between"
              @click="() => { closeMenu(); workspaceStore.newWorkspaceInNewWindowFlow() }"
            >
              <span class="inline-flex items-center gap-2 text-text-main">
                <Plus :size="16" class="text-text-muted" />
                新建工作空间（选择创建的位置）
              </span>
              <span class="text-[11px] text-text-subtle">Ctrl+Shift+N</span>
            </button>

            <button
              class="w-full px-3 py-2 text-left text-sm hover:bg-accent-soft flex items-center justify-between"
              @click="() => { closeMenu(); workspaceStore.openCommandPalette() }"
            >
              <span class="inline-flex items-center gap-2 text-text-main">
                <Command :size="16" class="text-text-muted" />
                打开命令面板
              </span>
              <span class="text-[11px] text-text-subtle">Ctrl+Shift+P</span>
            </button>
          </div>
        </div>
      </div>

      <div class="flex items-center gap-1" style="-webkit-app-region: no-drag">
        <button
          class="w-9 h-9 inline-flex items-center justify-center rounded-md text-text-muted hover:bg-accent-soft"
          title="最小化"
          @click="minimizeWindow"
        >
          <Minus :size="16" />
        </button>
        <button
          class="w-9 h-9 inline-flex items-center justify-center rounded-md text-text-muted hover:bg-accent-soft"
          title="最大化"
          @click="toggleMaximizeWindow"
        >
          <Square :size="16" />
        </button>
        <button
          class="w-9 h-9 inline-flex items-center justify-center rounded-md text-text-muted hover:bg-danger hover:text-white"
          title="关闭"
          @click="closeWindow"
        >
          <X :size="16" />
        </button>
      </div>
    </div>
  </header>
</template>
