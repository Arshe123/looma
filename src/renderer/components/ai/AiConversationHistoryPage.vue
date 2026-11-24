<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import { Search } from 'lucide-vue-next'
import AiConversationHistoryPanel from './AiConversationHistoryPanel.vue'

const searchQuery = ref('')
const scrollRoot = shallowRef<HTMLElement | null>(null)
</script>

<template>
  <div class="h-full overflow-y-auto bg-panel text-text-main" ref="scrollRoot">
    <div class="mx-auto max-w-5xl px-4 py-6 sm:px-7">
      <header class="mb-5">
        <div class="flex items-center justify-between gap-3">
          <h1 class="shrink-0 whitespace-nowrap text-2xl font-semibold">历史对话</h1>
          <label class="flex h-10 min-w-0 max-w-sm flex-1 items-center gap-2 rounded-xl border border-border-soft bg-panel-soft px-3 text-sm text-text-muted focus-within:border-accent">
            <Search :size="16" class="shrink-0" />
            <input
              v-model="searchQuery"
              type="search"
              aria-label="搜索标题或最近问题"
              class="min-w-0 flex-1 bg-transparent text-text-main outline-none placeholder:text-text-subtle"
              placeholder="搜索标题或最近问题"
            >
          </label>
        </div>
        <p class="mt-1 text-xs text-text-muted">按最后更新时间回顾对话</p>
      </header>
      <AiConversationHistoryPanel :search-query="searchQuery" :scroll-root="scrollRoot" />
    </div>
  </div>
</template>
