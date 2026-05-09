<script setup lang="ts">
import { ref } from 'vue'
import { useWorkspaceStore } from '../store/workspace'
import FileTree from './FileTree.vue'
import { Folders, Sun, Moon, GitBranch, Bot } from 'lucide-vue-next'

const workspaceStore = useWorkspaceStore()
const isOpen = ref(true)

const toggleSidebar = () => {
  isOpen.value = !isOpen.value
}
</script>

<template>
  <aside class="h-full flex border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
    <div class="w-14 h-full border-r border-zinc-200 dark:border-zinc-800 flex flex-col justify-between py-2">
      <div class="flex flex-col items-center gap-2">
        <button
          @click="toggleSidebar"
          :class="[
            'p-2 rounded-md text-zinc-600 dark:text-zinc-400',
            isOpen ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-200 dark:hover:bg-zinc-800'
          ]"
          :title="isOpen ? '收起文件树' : '展开文件树'"
        >
          <Folders :size="20" />
        </button>

        <button
          class="p-2 rounded-md text-zinc-400 cursor-not-allowed"
          title="AI Assistant (Coming Soon)"
          disabled
        >
          <Bot :size="20" />
        </button>

        <button
          class="p-2 rounded-md text-zinc-400 cursor-not-allowed"
          title="Git History (Coming Soon)"
          disabled
        >
          <GitBranch :size="20" />
        </button>
      </div>

      <div class="flex flex-col items-center gap-2">
        <button
          @click="workspaceStore.toggleTheme"
          class="p-2 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
          :title="workspaceStore.theme === 'light' ? '切换到夜间模式' : '切换到日间模式'"
        >
          <Sun v-if="workspaceStore.theme === 'light'" :size="20" />
          <Moon v-else :size="20" />
        </button>
      </div>
    </div>

    <div
      :class="[
        'h-full overflow-hidden',
        isOpen ? 'w-64 border-r border-zinc-200 dark:border-zinc-800' : 'w-0 border-r-0'
      ]"
    >
      <div v-if="isOpen" class="h-full flex flex-col">
        <div class="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800">
          <div class="text-xs font-semibold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider">文件</div>
        </div>

        <div class="flex-1 overflow-hidden">
          <div v-if="workspaceStore.workspaces.length === 0" class="p-4">
            <div class="text-sm font-semibold text-zinc-800 dark:text-zinc-100">未打开工作空间</div>
            <div class="mt-2 text-xs text-zinc-500 dark:text-zinc-400">请选择一个本地文件夹作为工作空间。</div>
            <div class="mt-4 grid grid-cols-1 gap-2">
              <button
                class="w-full px-3 py-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 text-sm"
                @click="workspaceStore.openWorkspaceInNewWindowFlow()"
              >
                打开工作空间 (Ctrl+O)
              </button>
              <button
                class="w-full px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm"
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
  </aside>
</template>
