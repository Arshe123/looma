<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Bot, Folders, GitBranch, Monitor, Moon, Sun, UserRound } from 'lucide-vue-next'
import { useWorkspaceStore } from '../store/workspace'
import AuthModal from './auth/AuthModal.vue'
import UserMenu from './auth/UserMenu.vue'
import FileTree from './FileTree.vue'

const props = defineProps<{
  width: number
}>()

const workspaceStore = useWorkspaceStore()
const isOpen = ref(true)
const isMockLoggedIn = ref(true)
const mockUsername = ref('with-you 用户')
const authModalOpen = ref(false)
const authModalMode = ref<'login' | 'register'>('login')
const userMenuOpen = ref(false)
const toolbarWidth = 56
const panelWidth = computed(() => Math.max(0, props.width - toolbarWidth))

const toggleSidebar = () => {
  isOpen.value = !isOpen.value
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
          @click="toggleSidebar"
          :class="[
            'p-2 rounded-md text-text-muted cursor-pointer',
            isOpen ? 'bg-accent-soft text-text-main' : 'hover:bg-accent-soft hover:text-text-main'
          ]"
          :title="isOpen ? '收起文件树' : '展开文件树'"
        >
          <Folders :size="20" />
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
      </div>
    </div>

    <div
      :class="['h-full overflow-hidden bg-panel rounded-lg', isOpen ?? 'w-0']"
      :style="{ width: isOpen ? `${panelWidth}px` : '0px' }"
    >
      <div v-if="isOpen" class="h-full flex flex-col">
        <div class="px-3 py-2 border-border-soft">
          <div class="text-xs font-semibold text-text-muted uppercase tracking-wider">文件树</div>
        </div>

        <div class="flex-1 overflow-hidden">
          <div v-if="workspaceStore.workspaces.length === 0" class="p-4">
            <div class="text-sm font-semibold text-text-main">暂未打开工作空间。请从本地文件夹开始使用</div>
            <div class="mt-2 text-xs text-text-muted">请选择一个本地文件夹作为您的工作空间。</div>
            <div class="mt-4 grid grid-cols-1 gap-2">
              <button
                class="w-full px-3 py-2 rounded-lg bg-accent-soft hover:bg-accent-soft text-text-main text-sm"
                @click="workspaceStore.openWorkspaceInNewWindowFlow()"
              >
                打开工作空间 (Ctrl+O)
              </button>
              <button
                class="w-full px-3 py-2 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm"
                @click="workspaceStore.newWorkspaceInNewWindowFlow()"
              >
                新建工作空间 (Ctrl+Shift+N)
              </button>
            </div>
          </div>
          <div v-if="workspaceStore.activeWorkspaceId" class="h-full pt-2">
            <FileTree />
          </div>
        </div>
      </div>
    </div>

    <AuthModal :open="authModalOpen" :initialMode="authModalMode" @close="closeAuthModal" />
  </aside>
</template>
