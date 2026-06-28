<script setup lang="ts">
import { computed, ref } from 'vue'
import { Archive, Clock3, Edit3, Inbox, MessageSquare, Pin, Search, Star, Trash2 } from 'lucide-vue-next'
import { useWorkspaceStore, type AiAssistantConversation } from '@/renderer/stores/workspace'
import { getAiAssistantHistoryGroup } from '@/renderer/stores/workspace-ai-utils'

const workspaceStore = useWorkspaceStore()

type FilterKey = 'all' | 'pinned' | 'favorite' | 'archived'

const searchQuery = ref('')
const filter = ref<FilterKey>('all')
const categoryFilter = ref('all')

const filters: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'pinned', label: '置顶' },
  { key: 'favorite', label: '收藏' },
  { key: 'archived', label: '归档' },
]

const conversations = computed(() => workspaceStore.aiAssistantConversations)
const favoriteCategories = computed(() => {
  const categories = conversations.value
    .map((conversation) => conversation.favoriteCategory?.trim())
    .filter((value): value is string => Boolean(value))
  return Array.from(new Set(categories)).sort((a, b) => a.localeCompare(b, 'zh-CN'))
})

const getLastUserPreview = (conversation: AiAssistantConversation) => {
  const userMessage = [...conversation.messages].reverse().find((message) => message.role === 'user' && message.text.trim())
  return userMessage?.text.trim().replace(/\s+/g, ' ') || '暂无用户问题'
}

const formatTime = (timestamp: number) => {
  if (!Number.isFinite(timestamp)) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

const matchesSearch = (conversation: AiAssistantConversation) => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return true
  return conversation.title.toLowerCase().includes(q)
    || getLastUserPreview(conversation).toLowerCase().includes(q)
}

const filteredConversations = computed(() => conversations.value
  .filter((conversation) => {
    if (filter.value === 'archived') return conversation.archived
    if (conversation.archived) return false
    if (filter.value === 'pinned') return conversation.pinned
    if (filter.value === 'favorite') return conversation.favorite
    return true
  })
  .filter((conversation) => categoryFilter.value === 'all' || conversation.favoriteCategory === categoryFilter.value)
  .filter(matchesSearch))

const pinnedConversations = computed(() => filteredConversations.value.filter((conversation) => conversation.pinned))
const timelineConversations = computed(() => filteredConversations.value.filter((conversation) => !conversation.pinned))
const timelineGroups = computed(() => {
  const labels = ['近 7 日', '近 30 日', '近 90 日', '更早'] as const
  return labels
    .map((label) => ({
      label,
      items: timelineConversations.value.filter((conversation) => getAiAssistantHistoryGroup(conversation.updatedAt) === label),
    }))
    .filter((group) => group.items.length > 0)
})

const selectConversation = (id: string) => {
  workspaceStore.setActiveAiAssistantConversation(id)
  workspaceStore.setActiveSidebarPanel('ai')
}

const renameConversation = async (conversation: AiAssistantConversation) => {
  const next = await workspaceStore.requestTextInput('编辑对话标题', conversation.title, '请输入对话标题')
  if (!next?.trim()) return
  workspaceStore.renameAiAssistantConversation(conversation.id, next)
}

const editFavoriteCategory = async (conversation: AiAssistantConversation) => {
  const next = await workspaceStore.requestTextInput('收藏分类', conversation.favoriteCategory || '默认收藏', '例如：论文 / 项目 / 灵感')
  if (!next?.trim()) return
  workspaceStore.setAiAssistantConversationFavoriteCategory(conversation.id, next)
}

const toggleFavorite = async (conversation: AiAssistantConversation) => {
  if (conversation.favorite) {
    workspaceStore.toggleFavoriteAiAssistantConversation(conversation.id)
    return
  }
  const next = await workspaceStore.requestTextInput('收藏分类', conversation.favoriteCategory || '默认收藏', '例如：论文 / 项目 / 灵感')
  workspaceStore.toggleFavoriteAiAssistantConversation(conversation.id, next?.trim() || '默认收藏')
}

const deleteConversation = (conversation: AiAssistantConversation) => {
  const ok = window.confirm(`删除对话「${conversation.title || '新对话'}」？此操作不可恢复。`)
  if (!ok) return
  workspaceStore.deleteAiAssistantConversation(conversation.id)
}
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col gap-4">
    <div class="flex flex-col gap-3 rounded-2xl border border-border-soft bg-panel p-3 shadow-sm lg:flex-row lg:items-center lg:justify-between">
      <label class="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl border border-border-soft bg-panel-soft px-3 text-sm text-text-muted lg:max-w-md">
        <Search :size="16" class="shrink-0" />
        <input
          v-model="searchQuery"
          class="min-w-0 flex-1 bg-transparent text-text-main outline-none placeholder:text-text-subtle"
          placeholder="搜索标题或最近问题"
        >
      </label>
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-for="item in filters"
          :key="item.key"
          type="button"
          class="h-9 rounded-lg border px-3 text-xs font-medium transition-colors"
          :class="filter === item.key ? 'border-accent bg-accent text-white' : 'border-border-soft bg-panel-soft text-text-muted hover:text-text-main'"
          @click="filter = item.key"
        >
          {{ item.label }}
        </button>
        <select
          v-model="categoryFilter"
          class="h-9 rounded-lg border border-border-soft bg-panel-soft px-3 text-xs text-text-muted outline-none"
        >
          <option value="all">全部分类</option>
          <option v-for="category in favoriteCategories" :key="category" :value="category">
            {{ category }}
          </option>
        </select>
      </div>
    </div>

    <div v-if="filteredConversations.length === 0" class="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-border-soft bg-panel/70 p-10 text-center text-text-muted">
      <Inbox :size="42" class="mb-3 text-text-subtle" />
      <div class="text-sm font-medium text-text-main">暂无匹配的历史对话</div>
      <p class="mt-1 text-xs text-text-subtle">发送第一条问题后，正式对话才会出现在这里。</p>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border-soft bg-panel p-4">
      <div v-if="pinnedConversations.length" class="mb-6">
        <div class="mb-3 flex items-center gap-2 text-xs font-semibold text-text-muted">
          <Pin :size="14" />
          置顶
        </div>
        <div class="grid gap-3 xl:grid-cols-2">
          <article
            v-for="conversation in pinnedConversations"
            :key="conversation.id"
            class="rounded-2xl border border-accent/20 bg-accent-soft/40 p-4 transition-colors hover:border-accent/40"
          >
            <div class="flex items-start justify-between gap-3">
              <button type="button" class="min-w-0 flex-1 text-left" @click="selectConversation(conversation.id)">
                <h3 class="truncate text-sm font-semibold text-text-main">{{ conversation.title }}</h3>
                <p class="mt-1 line-clamp-2 text-xs leading-5 text-text-muted">{{ getLastUserPreview(conversation) }}</p>
              </button>
              <span class="rounded-full bg-panel px-2 py-0.5 text-[10px] text-accent">置顶</span>
            </div>
            <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-subtle">
              <span class="inline-flex items-center gap-1"><Clock3 :size="12" />{{ formatTime(conversation.updatedAt) }}</span>
              <span>{{ conversation.messages.length }} 条消息</span>
            </div>
            <div class="mt-3 flex flex-wrap gap-1.5">
              <button class="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main" type="button" @click="renameConversation(conversation)"><Edit3 :size="12" />标题</button>
              <button class="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main" type="button" @click="workspaceStore.togglePinAiAssistantConversation(conversation.id)"><Pin :size="12" />取消置顶</button>
              <button class="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main" type="button" @click="toggleFavorite(conversation)"><Star :size="12" />{{ conversation.favorite ? '取消收藏' : '收藏' }}</button>
              <button v-if="conversation.favorite" class="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main" type="button" @click="editFavoriteCategory(conversation)">分类</button>
              <button class="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main" type="button" @click="workspaceStore.toggleArchiveAiAssistantConversation(conversation.id)"><Archive :size="12" />{{ conversation.archived ? '取消归档' : '归档' }}</button>
              <button class="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main hover:text-danger" type="button" @click="deleteConversation(conversation)"><Trash2 :size="12" />删除</button>
            </div>
          </article>
        </div>
      </div>

      <div class="relative flex flex-col gap-6 before:absolute before:left-[7px] before:top-2 before:bottom-2 before:w-px before:bg-border-soft">
        <section v-for="group in timelineGroups" :key="group.label" class="relative pl-7">
          <div class="absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full border-2 border-panel bg-accent" />
          <h2 class="mb-3 text-xs font-semibold text-text-muted">{{ group.label }}</h2>
          <div class="grid gap-3 xl:grid-cols-2">
            <article
              v-for="conversation in group.items"
              :key="conversation.id"
              class="group rounded-2xl border border-border-soft bg-panel-soft p-4 transition-colors hover:border-accent/30 hover:bg-panel"
            >
              <div class="flex items-start justify-between gap-3">
                <button type="button" class="min-w-0 flex-1 text-left" @click="selectConversation(conversation.id)">
                  <h3 class="truncate text-sm font-semibold text-text-main">{{ conversation.title }}</h3>
                  <p class="mt-1 line-clamp-2 text-xs leading-5 text-text-muted">{{ getLastUserPreview(conversation) }}</p>
                </button>
                <div class="flex shrink-0 gap-1">
                  <span v-if="conversation.favorite" class="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700">{{ conversation.favoriteCategory || '收藏' }}</span>
                  <span v-if="conversation.archived" class="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-600">归档</span>
                </div>
              </div>
              <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-text-subtle">
                <span class="inline-flex items-center gap-1"><Clock3 :size="12" />{{ formatTime(conversation.updatedAt) }}</span>
                <span class="inline-flex items-center gap-1"><MessageSquare :size="12" />{{ conversation.messages.length }} 条消息</span>
              </div>
              <div class="mt-3 flex flex-wrap gap-1.5">
                <button class="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main" type="button" @click="renameConversation(conversation)"><Edit3 :size="12" />标题</button>
                <button class="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main" type="button" @click="workspaceStore.togglePinAiAssistantConversation(conversation.id)"><Pin :size="12" />置顶</button>
                <button class="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main" type="button" @click="toggleFavorite(conversation)"><Star :size="12" />{{ conversation.favorite ? '取消收藏' : '收藏' }}</button>
                <button v-if="conversation.favorite" class="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main" type="button" @click="editFavoriteCategory(conversation)">分类</button>
                <button class="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main" type="button" @click="workspaceStore.toggleArchiveAiAssistantConversation(conversation.id)"><Archive :size="12" />{{ conversation.archived ? '取消归档' : '归档' }}</button>
                <button class="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main hover:text-danger" type="button" @click="deleteConversation(conversation)"><Trash2 :size="12" />删除</button>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>
