<script setup lang="ts">
import { ref } from 'vue'
import { useWorkspaceStore } from '../store/workspace'
import FileTree from './FileTree.vue'
import { ChevronLeft, ChevronRight, Sun, Moon, GitBranch, Bot } from 'lucide-vue-next'

const workspaceStore = useWorkspaceStore()
const isCollapsed = ref(false)

const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value
}
</script>

<template>
  <aside 
    :class="[
      'h-full border-r transition-all duration-300 flex flex-col',
      isCollapsed ? 'w-16' : 'w-64',
      'bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800'
    ]"
  >
    <div class="px-3 py-2 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800">
      <div v-if="!isCollapsed" class="text-xs font-semibold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider">文件</div>
      <button @click="toggleCollapse" class="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-500">
        <ChevronLeft v-if="!isCollapsed" :size="18" />
        <ChevronRight v-else :size="18" />
      </button>
    </div>

    <div class="flex-1 overflow-hidden">
      <div v-if="!isCollapsed && workspaceStore.workspaces.length === 0" class="p-4">
        <div class="text-sm font-semibold text-zinc-800 dark:text-zinc-100">未打开工作空间</div>
        <div class="mt-2 text-xs text-zinc-500 dark:text-zinc-400">请选择一个本地文件夹作为工作空间。</div>
        <div class="mt-4 grid grid-cols-1 gap-2">
          <button
            class="w-full px-3 py-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 text-sm"
            @click="workspaceStore.switchWorkspaceFlow()"
          >
            切换工作空间 (Ctrl+O)
          </button>
          <button
            class="w-full px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm"
            @click="workspaceStore.newWorkspaceFlow()"
          >
            新建工作空间 (Ctrl+Shift+N)
          </button>
        </div>
      </div>
      <div v-if="!isCollapsed && workspaceStore.activeWorkspaceId" class="h-full pt-2">
        <FileTree
          :workspaceId="workspaceStore.activeWorkspaceId"
        />
      </div>
    </div>

    <!-- Footer Controls -->
    <div class="p-4 border-t border-zinc-200 dark:border-zinc-800 space-y-2">
      <div class="flex items-center gap-2">
        <button 
          @click="workspaceStore.toggleTheme" 
          class="p-2 rounded-md hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
          :title="workspaceStore.theme === 'light' ? '切换到夜间模式' : '切换到日间模式'"
        >
          <Sun v-if="workspaceStore.theme === 'light'" :size="20" />
          <Moon v-else :size="20" />
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
      
      <!-- TODO: 实现用户行为数据收集功能
           1）建立与后台服务的数据交互接口，用于收集和上报用户的使用统计数据（包括页面访问频次、功能使用时长、点击事件等关键指标）；
           2）实现软件更新推送机制，能够定期检查服务器版本信息，向用户展示更新提示并提供一键升级功能。
           要求整个实现过程保证数据收集的合规性（需获得用户授权），网络请求的安全性（采用HTTPS协议和数据加密），以及更新推送的可靠性（支持断点续传和版本回滚）。
      -->
    </div>
  </aside>
</template>
