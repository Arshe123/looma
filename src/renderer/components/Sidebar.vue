<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Bot, Folders, GitBranch, Monitor, Moon, Sun, TableOfContents, UserRound, Settings } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import type { SidebarPanelId } from '@/renderer/stores/workspace'
import type { LoginUser } from '@/renderer/services/authApi'

import AiAssistant from './ai/AiAssistant.vue'
import AuthModal from './auth/AuthModal.vue'
import UserMenu from './auth/UserMenu.vue'
import FeedbackModal from './feedback/FeedbackModal.vue'
import UpdateModal from './update/UpdateModal.vue'
import FileTree from './FileTree.vue'
import OutlinePanel from './OutlinePanel.vue'

const props = defineProps<{
  width: number
}>()

const workspaceStore = useWorkspaceStore()
const authUser = ref<LoginUser | null>(JSON.parse(localStorage.getItem('looma:user') || 'null') as LoginUser | null)
const authEmail = ref(localStorage.getItem('looma:userEmail') || '')
const isMockLoggedIn = computed(() => Boolean(authUser.value?.token))
const mockUsername = computed(() => authEmail.value || authUser.value?.username || '未登录')
const authUserId = computed(() => authUser.value?.id)
const authModalOpen = ref(false)
const authModalMode = ref<'login' | 'register'>('register')

const userMenuOpen = ref(false)
const feedbackModalOpen = ref(false)
const updateModalOpen = ref(false)
const appVersion = ref('0.0.0')
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

const openFeedbackModal = () => {
  closeUserMenu()
  feedbackModalOpen.value = true
}

const closeFeedbackModal = () => {
  feedbackModalOpen.value = false
}

const handleFeedbackRequireLogin = () => {
  closeFeedbackModal()
  openAuthModal('login')
}

const openUpdateModal = () => {
  closeUserMenu()
  updateModalOpen.value = true
}

const closeUpdateModal = () => {
  updateModalOpen.value = false
}

const handleLogout = () => {
  authUser.value = null
  authEmail.value = ''
  localStorage.removeItem('looma:user')
  localStorage.removeItem('looma:userEmail')
  closeUserMenu()
}

const handleAuthenticated = ({ email, user }: { email: string; user: LoginUser }) => {
  authUser.value = user
  authEmail.value = email
  localStorage.setItem('looma:user', JSON.stringify(user))
  localStorage.setItem('looma:userEmail', email)
  closeAuthModal()
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
    closeFeedbackModal()
    closeUpdateModal()
  }

  window.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('keydown', onKeyDown)

  cleanupUserEntry = () => {
    window.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('keydown', onKeyDown)
  }

  // 获取当前应用版本号
  window.electronAPI.app.getVersion().then((v) => {
    if (v) appVersion.value = v
  }).catch(() => { /* 降级为 0.0.0 */ })
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
        <!-- <div class="relative" data-user-entry>
          <button
            class="p-2 rounded-md text-text-muted hover:bg-accent-soft hover:text-text-main cursor-pointer"
            :class="{ 'bg-accent-soft text-text-main': authModalOpen || userMenuOpen }"
            :title="isMockLoggedIn ? '用户' : '注册账号'"
            @click="toggleUserEntry"
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
            @report="openFeedbackModal"
            @checkUpdate="openUpdateModal"
            @close="closeUserMenu"
          />
        </div> -->

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
        <FileTree v-if="workspaceStore.activeSidebarPanel === 'files'" />
        <OutlinePanel v-else-if="workspaceStore.activeSidebarPanel === 'outline'" />
        <AiAssistant v-else-if="workspaceStore.activeSidebarPanel === 'ai'" />
      </div>
    </div>

    <AuthModal
      :open="authModalOpen"
      :initialMode="authModalMode"
      @close="closeAuthModal"
      @authenticated="handleAuthenticated"
    />

    <FeedbackModal
      :open="feedbackModalOpen"
      :isLoggedIn="isMockLoggedIn"
      :userId="authUserId"
      @close="closeFeedbackModal"
      @requireLogin="handleFeedbackRequireLogin"
    />

    <UpdateModal
      :open="updateModalOpen"
      :currentVersion="appVersion"
      @close="closeUpdateModal"
    />
  </aside>
</template>
