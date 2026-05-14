<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Bot, Folders, GitBranch, GripVertical, Monitor, Moon, Sun, TableOfContents, UserRound } from 'lucide-vue-next'
import { useWorkspaceStore } from '../store/workspace'
import type { SidebarPanelId, SidebarPanelState } from '../store/workspace'
import { resizeSidebarPanels } from '../store/sidebar-panels'
import { parseMarkdownOutline, type MarkdownOutlineItem } from './util/markdown-outline'
import AuthModal from './auth/AuthModal.vue'
import UserMenu from './auth/UserMenu.vue'
import FileTree from './FileTree.vue'

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
const panelContainerRef = ref<HTMLElement | null>(null)
const draggedPanelIndex = ref<number | null>(null)
const panelWidth = computed(() => Math.max(0, props.width - toolbarWidth))
const isOpen = computed(() => workspaceStore.sidebarPanels.length > 0)
const isMarkdownActive = computed(() => workspaceStore.activeFileRelativePath.toLowerCase().endsWith('.md'))
const outlineItems = computed(() => {
  if (!isMarkdownActive.value) return []
  return parseMarkdownOutline(workspaceStore.activeFileContent)
})

let resizingPanelIndex = -1
let resizingStartY = 0
let resizingStartPanels: SidebarPanelState[] = []
let resizingContainerHeight = 0
let previousBodyCursor = ''
let previousBodyUserSelect = ''

const panelTitles: Record<SidebarPanelId, string> = {
  files: '文件树',
  outline: '大纲',
}

const isPanelOpen = (id: SidebarPanelId) => workspaceStore.sidebarPanels.some((panel) => panel.id === id)

const togglePanel = (id: SidebarPanelId) => {
  if (id === 'outline' && !isMarkdownActive.value && !isPanelOpen(id)) return
  workspaceStore.toggleSidebarPanel(id)
}

const stopPanelResize = () => {
  if (resizingPanelIndex === -1) return
  resizingPanelIndex = -1
  resizingStartPanels = []
  resizingContainerHeight = 0
  document.body.style.cursor = previousBodyCursor
  document.body.style.userSelect = previousBodyUserSelect
  window.removeEventListener('pointermove', onPanelResizeMove)
  window.removeEventListener('pointerup', stopPanelResize)
  window.removeEventListener('pointercancel', stopPanelResize)
  workspaceStore.persistSidebarPanels()
}

const onPanelResizeMove = (event: PointerEvent) => {
  if (resizingPanelIndex === -1 || resizingContainerHeight <= 0) return
  const deltaRatio = (event.clientY - resizingStartY) / resizingContainerHeight
  workspaceStore.sidebarPanels = resizeSidebarPanels(resizingStartPanels, resizingPanelIndex, deltaRatio)
}

const startPanelResize = (event: PointerEvent, index: number) => {
  if (event.button !== 0) return
  event.preventDefault()
  resizingPanelIndex = index
  resizingStartY = event.clientY
  resizingStartPanels = workspaceStore.sidebarPanels.map((panel) => ({ ...panel }))
  resizingContainerHeight = panelContainerRef.value?.getBoundingClientRect().height || 0
  previousBodyCursor = document.body.style.cursor
  previousBodyUserSelect = document.body.style.userSelect
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
  window.addEventListener('pointermove', onPanelResizeMove)
  window.addEventListener('pointerup', stopPanelResize)
  window.addEventListener('pointercancel', stopPanelResize)
}

const startPanelDrag = (event: DragEvent, index: number) => {
  draggedPanelIndex.value = index
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
  }
}

const onPanelDragOver = (event: DragEvent, index: number) => {
  event.preventDefault()
  const fromIndex = draggedPanelIndex.value
  if (fromIndex === null || fromIndex === index) return
  workspaceStore.reorderSidebarPanels(fromIndex, index)
  draggedPanelIndex.value = index
}

const stopPanelDrag = () => {
  draggedPanelIndex.value = null
}

const jumpToHeading = (item: MarkdownOutlineItem) => {
  window.dispatchEvent(new CustomEvent('looma:jump-to-heading', { detail: item }))
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
  stopPanelResize()
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
      </div>
    </div>

    <div
      class="h-full overflow-hidden bg-panel rounded-lg"
      :style="{ width: isOpen ? `${panelWidth}px` : '0px' }"
    >
      <div v-if="isOpen" ref="panelContainerRef" class="h-full flex flex-col min-h-0">
        <template v-for="(panel, index) in workspaceStore.sidebarPanels" :key="panel.id">
          <section
            class="min-h-0 flex flex-col overflow-hidden"
            :style="{ flex: `${panel.size} 1 0` }"
            @dragover="(event) => onPanelDragOver(event, index)"
            @drop.prevent="stopPanelDrag"
          >
            <div
              class="h-9 shrink-0 px-3 flex items-center gap-2 border-border-soft text-xs font-semibold text-text-muted uppercase tracking-wider cursor-grab active:cursor-grabbing"
              draggable="true"
              @dragstart="(event) => startPanelDrag(event, index)"
              @dragend="stopPanelDrag"
            >
              <GripVertical :size="14" class="text-text-subtle" />
              <span>{{ panelTitles[panel.id] }}</span>
            </div>

            <div class="flex-1 min-h-0 overflow-hidden">
              <template v-if="panel.id === 'files'">
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
                <div v-if="workspaceStore.activeWorkspaceId" class="h-full pt-2">
                  <FileTree />
                </div>
              </template>

              <template v-else-if="panel.id === 'outline'">
                <div v-if="!isMarkdownActive" class="h-full p-4 text-sm text-text-muted">
                  大纲仅支持 Markdown 文件。
                </div>
                <div v-else-if="outlineItems.length === 0" class="h-full p-4 text-sm text-text-muted">
                  当前 Markdown 文件暂无标题。
                </div>
                <div v-else class="h-full overflow-y-auto focus-scrollbar py-2">
                  <button
                    v-for="item in outlineItems"
                    :key="item.id"
                    class="group w-full min-h-8 pr-3 py-1.5 flex items-start gap-2 text-left text-sm text-text-muted hover:bg-accent-soft hover:text-text-main cursor-pointer"
                    :style="{ paddingLeft: `${10 + (item.level - 1) * 12}px` }"
                    :title="item.text"
                    @click="jumpToHeading(item)"
                  >
                    <span class="mt-[0.2rem] w-5 shrink-0 text-[10px] font-semibold text-text-subtle group-hover:text-text-muted">
                      H{{ item.level }}
                    </span>
                    <span class="min-w-0 flex-1 truncate">{{ item.text }}</span>
                  </button>
                </div>
              </template>
            </div>
          </section>

          <div
            v-if="index < workspaceStore.sidebarPanels.length - 1"
            class="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-accent-soft active:bg-accent"
            style="-webkit-app-region: no-drag"
            @pointerdown="(event) => startPanelResize(event, index)"
          />
        </template>
      </div>
    </div>

    <AuthModal :open="authModalOpen" :initialMode="authModalMode" @close="closeAuthModal" />
  </aside>
</template>
