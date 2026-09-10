<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Bot, Folders, TableOfContents, Settings, UserRound } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import type { SidebarPanelId } from '@/renderer/stores/workspace'
import { SIDEBAR_TOOLBAR_WIDTH } from '@/renderer/utils/sidebar-layout'


import UpdateModal from './update/UpdateModal.vue'
import UserMenu from './user/UserMenu.vue'
import FileTree from './FileTree.vue'


const props = defineProps<{
  width: number
}>()

const workspaceStore = useWorkspaceStore()
const userMenuOpen = ref(false)
const userEntryRef = ref<HTMLButtonElement | null>(null)
const updateModalOpen = ref(false)
const appVersion = ref('0.0.0')
const toolbarWidth = SIDEBAR_TOOLBAR_WIDTH
const panelWidth = computed(() => Math.max(0, props.width - toolbarWidth))
const isOpen = computed(() => workspaceStore.fileSidebarOpen)
const isOutlineAvailable = computed(() => {
  const tab = workspaceStore.activeTab
  return (tab?.kind === 'file' && tab.relativePath.toLowerCase().endsWith('.md'))
    || (tab?.kind === 'system' && tab.page === 'help')
})
const isPanelOpen = (id: SidebarPanelId) => id === 'files' ? workspaceStore.fileSidebarOpen : workspaceStore.activeAuxiliaryPanel === id

const togglePanel = (id: SidebarPanelId) => {
  if (id === 'outline' && !isOutlineAvailable.value && !isPanelOpen(id)) return
  workspaceStore.toggleSidebarPanel(id)
}

const closeUserMenu = () => {
  userMenuOpen.value = false
}

const toggleUserEntry = () => {
  userMenuOpen.value = !userMenuOpen.value
}

const openHelpPage = () => {
  closeUserMenu()
  workspaceStore.openHelpPage()
}

const openUpdateModal = () => {
  closeUserMenu()
  updateModalOpen.value = true
}

const closeUpdateModal = () => {
  updateModalOpen.value = false
}

let cleanupUserEntry: (() => void) | null = null

onMounted(() => {
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as HTMLElement | null
    if (!target) return
    if (target.closest('[data-user-entry]')) return
    closeUserMenu()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    closeUserMenu()
    closeUpdateModal()
  }

  window.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('resize', closeUserMenu)

  cleanupUserEntry = () => {
    window.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('resize', closeUserMenu)
  }

  // 获取当前应用版本号
  window.electronAPI.app.getVersion().then((v) => {
    if (v) appVersion.value = v
  }).catch(() => { /* 降级为 0.0.0 */ })

  // 界面和更新状态监听器都已就绪后再做一次启动检查。
  // 仅发现新版本时打开弹窗；最新版和检查失败都保持静默。
  window.electronAPI.app.update.startupCheck().then((result) => {
    if (result.notify && result.state.status === 'available') openUpdateModal()
  }).catch((error) => {
    console.error('[update:startup-check] Failed', error)
  })
})

onUnmounted(() => {
  cleanupUserEntry?.()
  cleanupUserEntry = null
})
</script>

<template>
  <aside
    class="h-full flex shrink-0 overflow-hidden"
    :style="{ width: `${isOpen ? props.width : toolbarWidth}px` }"
  >
    <div class="w-14 h-full flex flex-col justify-between py-2">
      <div class="flex flex-col items-center gap-2">
        <button
          @click="togglePanel('files')"
          :class="[
            'p-2 rounded-md text-text-muted cursor-pointer',
            isPanelOpen('files') ? 'bg-accent-soft text-text-main' : 'hover:bg-accent-soft hover:text-text-main'
          ]"
          :title="isPanelOpen('files') ? '关闭文件树' : '打开文件树'"
        >
          <Folders :size="20" />
        </button>

        <button
          @click="togglePanel('outline')"
          :disabled="!isOutlineAvailable && !isPanelOpen('outline')"
          :class="[
            'p-2 rounded-md',
            isPanelOpen('outline')
              ? 'bg-accent-soft text-text-main cursor-pointer'
              : isOutlineAvailable
                ? 'text-text-muted hover:bg-accent-soft hover:text-text-main cursor-pointer'
                : 'text-text-subtle cursor-not-allowed'
          ]"
          :title="isOutlineAvailable ? (isPanelOpen('outline') ? '关闭大纲' : '打开大纲') : '大纲仅支持 Markdown 文件'"
        >
          <TableOfContents :size="20" />
        </button>

        <button
          @click="togglePanel('ai')"
          :class="[
            'p-2 rounded-md text-text-muted cursor-pointer',
            isPanelOpen('ai') ? 'bg-accent-soft text-text-main' : 'hover:bg-accent-soft hover:text-text-main'
          ]"
          :title="isPanelOpen('ai') ? '关闭 AI 助手' : 'AI 助手'"
        >
          <Bot :size="20" />
        </button>

        <!-- <button class="p-2 rounded-md text-text-subtle cursor-not-allowed" title="Git History (Coming Soon)" disabled>
          <GitBranch :size="20" />
        </button> -->
      </div>

      <div class="flex flex-col items-center gap-2">
        <div class="relative" data-user-entry>
          <button
            ref="userEntryRef"
            class="p-2 rounded-md text-text-muted hover:bg-accent-soft hover:text-text-main cursor-pointer"
            :class="{ 'bg-accent-soft text-text-main': userMenuOpen }"
            title="更多"
            @click="toggleUserEntry"
          >
            <UserRound :size="20" />
          </button>

          <UserMenu
            :open="userMenuOpen"
            :anchor="userEntryRef"
            @checkUpdate="openUpdateModal"
            @help="openHelpPage"
            @close="closeUserMenu"
          />
        </div>



        <button
          @click="workspaceStore.openSettingsPage()"
          class="p-2 rounded-md text-text-muted hover:bg-accent-soft hover:text-text-main cursor-pointer"
          title="系统设置"
        >
          <Settings :size="20" />
        </button>
      </div>
    </div>

    <div
      class="h-full overflow-hidden bg-panel rounded-[15px]"
      :style="{ width: isOpen ? `${panelWidth}px` : '0px' }"
    >
      <div v-if="isOpen" class="h-full min-h-0 overflow-hidden">
        <FileTree />
      </div>
    </div>

    <UpdateModal
      :open="updateModalOpen"
      :currentVersion="appVersion"
      @close="closeUpdateModal"
    />
  </aside>
</template>
