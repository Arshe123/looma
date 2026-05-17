<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Bot, Folders, GitBranch, Monitor, Moon, Sun, TableOfContents, UserRound, Settings } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/store/workspace'
import type { SidebarPanelId } from '@/store/workspace'
import AuthModal from './auth/AuthModal.vue'
import UserMenu from './auth/UserMenu.vue'
import FileTree from './FileTree.vue'
import OutlinePanel from './OutlinePanel.vue'

const props = defineProps<{
  width: number
}>()

const workspaceStore = useWorkspaceStore()
const isMockLoggedIn = ref(true)
const mockUsername = ref('looma 用户')
const authModalOpen = ref(false)
const authModalMode = ref<'login' | 'register'>('login')
const userMenuOpen = ref(false)
const toolbarWidth = 56
const panelWidth = computed(() => Math.max(0, props.width - toolbarWidth))
const isOpen = computed(() => workspaceStore.activeSidebarPanel !== null)
const isMarkdownActive = computed(() => workspaceStore.activeFileRelativePath.toLowerCase().endsWith('.md'))
const isPanelOpen = (id: SidebarPanelId) => workspaceStore.activeSidebarPanel === id

const togglePanel = (id: SidebarPanelId) => {
  if (id === 'outline' && !isMarkdownActive.value && !isPanelOpen(id)) return
  workspaceStore.toggleSidebarPanel(id)
}

const closeAuthModal = () => {
  authModalOpen.value = false
}

const closeUserMenu = () => {
  userMenuOpen.value = false
}

const openAuthModal = (mode: 'login' | 'register') => {
  closeUserMenu()
  authModalMode.value = mode
  authModalOpen.value = true
}

const toggleUserEntry = () => {
  authModalOpen.value = false
  userMenuOpen.value = !userMenuOpen.value
}

const handleLogout = () => {
  isMockLoggedIn.value = false
  closeUserMenu()
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
    closeAuthModal()
  }

  window.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('keydown', onKeyDown)

  cleanupUserEntry = () => {
    window.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('keydown', onKeyDown)
  }
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
          :disabled="!isMarkdownActive && !isPanelOpen('outline')"
          :class="[
            'p-2 rounded-md',
            isPanelOpen('outline')
              ? 'bg-accent-soft text-text-main cursor-pointer'
              : isMarkdownActive
                ? 'text-text-muted hover:bg-accent-soft hover:text-text-main cursor-pointer'
                : 'text-text-subtle cursor-not-allowed'
          ]"
          :title="isMarkdownActive ? (isPanelOpen('outline') ? '关闭大纲' : '打开大纲') : '大纲仅支持 Markdown 文件'"
        >
          <TableOfContents :size="20" />
        </button>

        <button class="p-2 rounded-md text-text-subtle cursor-not-allowed" title="AI Assistant (Coming Soon)" disabled>
          <Bot :size="20" />
        </button>

        <button class="p-2 rounded-md text-text-subtle cursor-not-allowed" title="Git History (Coming Soon)" disabled>
          <GitBranch :size="20" />
        </button>
      </div>

      <div class="flex flex-col items-center gap-2">
        <div class="relative" data-user-entry>
          <button
            class="p-2 rounded-md text-text-subtle cursor-not-allowed"
            :class="{ 'bg-accent-soft text-text-main': authModalOpen || userMenuOpen }"
            title="用户（功能开发中，敬请期待）"
            @click="toggleUserEntry"
            disabled
          >
            <UserRound :size="20" />
          </button>

          <UserMenu
            :open="userMenuOpen"
            :isLoggedIn="isMockLoggedIn"
            :username="mockUsername"
            @login="openAuthModal('login')"
            @register="openAuthModal('register')"
            @logout="handleLogout"
            @close="closeUserMenu"
          />
        </div>

        <button
          @click="workspaceStore.toggleTheme"
          class="p-2 rounded-md text-text-muted hover:bg-accent-soft hover:text-text-main cursor-pointer"
          :title="workspaceStore.theme === 'light' ? '切换到日间模式' : workspaceStore.theme === 'dark' ? '跟随系统主题' : '切换到夜间模式'"
        >
          <Sun v-if="workspaceStore.theme === 'light'" :size="20" />
          <Moon v-else-if="workspaceStore.theme === 'dark'" :size="20" />
          <Monitor v-else :size="20" />
        </button>

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
      class="h-full overflow-hidden bg-panel rounded-lg"
      :style="{ width: isOpen ? `${panelWidth}px` : '0px' }"
    >
      <div v-if="isOpen" class="h-full min-h-0 overflow-hidden">
        <template v-if="workspaceStore.activeSidebarPanel === 'files'">
          <div v-if="workspaceStore.workspaces.length === 0" class="p-4">
            <div class="text-sm font-semibold text-text-main">暂未打开工作空间。请从本地文件夹开始使用</div>
            <div class="mt-2 text-xs text-text-muted">请选择或创建一个本地文件夹作为您的工作空间。</div>
            <div class="mt-4 grid grid-cols-1 gap-2">
              <button
                class="w-full px-3 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm cursor-pointer"
                @click="workspaceStore.openWorkspaceInNewWindowFlow()"
              >
                打开工作空间 (Ctrl+O)
              </button>
              <button
                class="w-full px-3 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm cursor-pointer"
                @click="workspaceStore.newWorkspaceInNewWindowFlow()"
              >
                新建工作空间 (Ctrl+Shift+N)
              </button>
            </div>
          </div>
          <div v-if="workspaceStore.activeWorkspaceId" class="h-full min-h-0 flex flex-col">
            <div class="shrink-0 px-4 py-3 text-sm font-semibold text-text-main">
              文件
            </div>
            <div class="min-h-0 flex-1 pt-2">
              <FileTree />
            </div>
          </div>
        </template>

        <div v-else-if="workspaceStore.activeSidebarPanel === 'outline'" class="h-full min-h-0 flex flex-col">
          <div class="shrink-0 px-4 py-3 text-sm font-semibold text-text-main">
            大纲
          </div>
          <div class="min-h-0 flex-1">
            <OutlinePanel />
          </div>
        </div>
      </div>
    </div>

    <AuthModal :open="authModalOpen" :initialMode="authModalMode" @close="closeAuthModal" />
  </aside>
</template>
