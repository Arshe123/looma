<script setup lang="ts">
import { computed } from 'vue'
import { Archive, MessageSquare, Pin, Star } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import AiConversationHistoryPanel from './AiConversationHistoryPanel.vue'

const workspaceStore = useWorkspaceStore()

const conversations = computed(() => workspaceStore.aiAssistantConversations)
const activeCount = computed(() => conversations.value.filter((conversation) => !conversation.archived).length)
const archivedCount = computed(() => conversations.value.filter((conversation) => conversation.archived).length)
const favoriteCount = computed(() => conversations.value.filter((conversation) => conversation.favorite).length)
const pinnedCount = computed(() => conversations.value.filter((conversation) => conversation.pinned).length)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-panel-soft p-5 text-text-main">
    <header class="mb-5 shrink-0 rounded-2xl border border-border-soft bg-panel p-5 shadow-sm">
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[420px]">
          <div class="rounded-xl border border-border-soft bg-panel-soft p-3">
            <div class="flex items-center gap-2 text-xs text-text-muted"><MessageSquare :size="13" />活跃</div>
            <div class="mt-1 text-lg font-semibold">{{ activeCount }}</div>
          </div>
          <div class="rounded-xl border border-border-soft bg-panel-soft p-3">
            <div class="flex items-center gap-2 text-xs text-text-muted"><Pin :size="13" />置顶</div>
            <div class="mt-1 text-lg font-semibold">{{ pinnedCount }}</div>
          </div>
          <div class="rounded-xl border border-border-soft bg-panel-soft p-3">
            <div class="flex items-center gap-2 text-xs text-text-muted"><Star :size="13" />收藏</div>
            <div class="mt-1 text-lg font-semibold">{{ favoriteCount }}</div>
          </div>
          <div class="rounded-xl border border-border-soft bg-panel-soft p-3">
            <div class="flex items-center gap-2 text-xs text-text-muted"><Archive :size="13" />归档</div>
            <div class="mt-1 text-lg font-semibold">{{ archivedCount }}</div>
          </div>
        </div>
    </header>

    <AiConversationHistoryPanel />
  </div>
</template>
