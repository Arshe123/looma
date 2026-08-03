<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Edit3,
  Inbox,
  MessageSquare,
  Pin,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-vue-next'
import { useWorkspaceStore, type AiAssistantConversation } from '@/renderer/stores/workspace'
import {
  normalizeAiAssistantFavoriteCategory,
  sortAiAssistantConversationsByUpdatedAt,
} from '@/renderer/stores/workspace-ai-utils'

const workspaceStore = useWorkspaceStore()

type FilterKey = 'all' | 'pinned' | 'favorite' | 'archived'

const PAGE_SIZE = 8
const searchQuery = ref('')
const filter = ref<FilterKey>('all')
const categoryFilter = ref('all')
const currentPage = ref(1)
const selectedIds = ref<string[]>([])

const filters: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'pinned', label: '置顶' },
  { key: 'favorite', label: '收藏' },
  { key: 'archived', label: '归档' },
]

const conversations = computed(() => sortAiAssistantConversationsByUpdatedAt(workspaceStore.aiAssistant.conversations))
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

const totalPages = computed(() => Math.max(1, Math.ceil(filteredConversations.value.length / PAGE_SIZE)))
const paginatedConversations = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE
  return filteredConversations.value.slice(start, start + PAGE_SIZE)
})
const visiblePages = computed(() => {
  const start = Math.max(1, Math.min(currentPage.value - 2, totalPages.value - 4))
  const end = Math.min(totalPages.value, start + 4)
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
})
const selectedSet = computed(() => new Set(selectedIds.value))
const allPageSelected = computed(() => (
  paginatedConversations.value.length > 0
  && paginatedConversations.value.every(conversation => selectedSet.value.has(conversation.id))
))

const clearSelection = () => {
  selectedIds.value = []
}

watch([searchQuery, filter, categoryFilter], () => {
  currentPage.value = 1
  clearSelection()
})

watch(totalPages, (value) => {
  if (currentPage.value > value) currentPage.value = value
})

const setPage = (page: number) => {
  currentPage.value = Math.min(totalPages.value, Math.max(1, page))
}

const toggleConversationSelection = (id: string) => {
  selectedIds.value = selectedSet.value.has(id)
    ? selectedIds.value.filter(item => item !== id)
    : [...selectedIds.value, id]
}

const togglePageSelection = (event: Event) => {
  const checked = (event.target as HTMLInputElement).checked
  const pageIds = new Set(paginatedConversations.value.map(conversation => conversation.id))
  selectedIds.value = checked
    ? Array.from(new Set([...selectedIds.value, ...pageIds]))
    : selectedIds.value.filter(id => !pageIds.has(id))
}

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
  const category = normalizeAiAssistantFavoriteCategory(next)
  if (category === null) return
  workspaceStore.toggleFavoriteAiAssistantConversation(conversation.id, category)
}

const deleteConversation = async (conversation: AiAssistantConversation) => {
  const ok = await workspaceStore.requestConfirmation({
    title: '删除对话',
    message: `删除对话「${conversation.title || '新对话'}」？此操作不可恢复。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  workspaceStore.deleteAiAssistantConversation(conversation.id)
  selectedIds.value = selectedIds.value.filter(id => id !== conversation.id)
}

const setSelectedPinned = (pinned: boolean) => {
  workspaceStore.setAiAssistantConversationsPinned(selectedIds.value, pinned)
  clearSelection()
}

const setSelectedFavorite = async (favorite: boolean) => {
  if (!favorite) {
    workspaceStore.setAiAssistantConversationsFavorite(selectedIds.value, false)
    clearSelection()
    return
  }
  const next = await workspaceStore.requestTextInput('批量收藏分类', '默认收藏', '例如：论文 / 项目 / 灵感')
  const category = normalizeAiAssistantFavoriteCategory(next)
  if (category === null) return
  workspaceStore.setAiAssistantConversationsFavorite(selectedIds.value, true, category)
  clearSelection()
}

const setSelectedArchived = (archived: boolean) => {
  workspaceStore.setAiAssistantConversationsArchived(selectedIds.value, archived)
  clearSelection()
}

const deleteSelected = async () => {
  const ok = await workspaceStore.requestConfirmation({
    title: '批量删除对话',
    message: `删除已选择的 ${selectedIds.value.length} 个对话？此操作不可恢复。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  workspaceStore.deleteAiAssistantConversations(selectedIds.value)
  clearSelection()
}
</script>

<template>
  <section class="flex min-h-0 flex-1 flex-col gap-3">
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

    <div
      v-if="selectedIds.length"
      class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent/25 bg-accent-soft/45 px-3 py-2 text-xs"
    >
      <span class="font-medium text-text-main">已选择 {{ selectedIds.length }} 项</span>
      <div class="flex flex-wrap items-center gap-1.5">
        <button type="button" class="rounded-lg px-2 py-1.5 text-text-muted hover:bg-panel hover:text-text-main" @click="setSelectedPinned(true)">置顶</button>
        <button type="button" class="rounded-lg px-2 py-1.5 text-text-muted hover:bg-panel hover:text-text-main" @click="setSelectedPinned(false)">取消置顶</button>
        <button type="button" class="rounded-lg px-2 py-1.5 text-text-muted hover:bg-panel hover:text-text-main" @click="setSelectedFavorite(true)">收藏</button>
        <button type="button" class="rounded-lg px-2 py-1.5 text-text-muted hover:bg-panel hover:text-text-main" @click="setSelectedFavorite(false)">取消收藏</button>
        <button type="button" class="rounded-lg px-2 py-1.5 text-text-muted hover:bg-panel hover:text-text-main" @click="setSelectedArchived(true)">归档</button>
        <button type="button" class="rounded-lg px-2 py-1.5 text-text-muted hover:bg-panel hover:text-text-main" @click="setSelectedArchived(false)">取消归档</button>
        <button type="button" class="rounded-lg px-2 py-1.5 text-danger hover:bg-danger/10" @click="deleteSelected">删除</button>
        <button type="button" class="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-lg text-text-subtle hover:bg-panel hover:text-text-main" title="取消选择" @click="clearSelection">
          <X :size="14" />
        </button>
      </div>
    </div>

    <div v-if="filteredConversations.length === 0" class="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-border-soft bg-panel/70 p-10 text-center text-text-muted">
      <Inbox :size="42" class="mb-3 text-text-subtle" />
      <div class="text-sm font-medium text-text-main">暂无匹配的历史对话</div>
      <p class="mt-1 text-xs text-text-subtle">发送第一条问题后，正式对话才会出现在这里。</p>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border-soft bg-panel p-3">
      <div class="mb-2 flex items-center justify-between gap-3 px-1 text-[11px] text-text-subtle">
        <label class="inline-flex items-center gap-2 text-text-muted">
          <input
            type="checkbox"
            class="h-3.5 w-3.5 accent-accent"
            :checked="allPageSelected"
            @change="togglePageSelection"
          >
          本页全选
        </label>
        <span>最新优先 · 共 {{ filteredConversations.length }} 个对话</span>
      </div>

      <div class="grid gap-2">
        <article
          v-for="conversation in paginatedConversations"
          :key="conversation.id"
          class="group grid grid-cols-[20px_minmax(0,1fr)_80px] items-center gap-2 rounded-xl border border-border-soft bg-panel-soft px-3 py-2.5 transition-colors hover:border-accent/30 hover:bg-panel sm:grid-cols-[22px_minmax(0,1fr)_110px]"
          :class="selectedSet.has(conversation.id) ? 'border-accent/50 bg-accent-soft/30' : ''"
        >
          <input
            type="checkbox"
            class="h-3.5 w-3.5 accent-accent"
            :checked="selectedSet.has(conversation.id)"
            :aria-label="`选择对话 ${conversation.title}`"
            @change="toggleConversationSelection(conversation.id)"
          >

          <div class="min-w-0">
            <div class="flex min-w-0 items-center gap-1.5">
              <button type="button" class="truncate text-left text-sm font-semibold text-text-main hover:text-accent" @click="selectConversation(conversation.id)">
                {{ conversation.title }}
              </button>
              <span v-if="conversation.pinned" class="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] text-accent">置顶</span>
              <span v-if="conversation.favorite" class="shrink-0 rounded-full bg-warning/10 px-1.5 py-0.5 text-[9px] text-warning">{{ conversation.favoriteCategory || '收藏' }}</span>
              <span v-if="conversation.archived" class="shrink-0 rounded-full bg-panel px-1.5 py-0.5 text-[9px] text-text-muted">归档</span>
            </div>
            <div class="mt-1 flex min-w-0 items-center gap-2">
              <button type="button" class="min-w-0 flex-1 truncate text-left text-xs text-text-muted hover:text-text-main" @click="selectConversation(conversation.id)">
                {{ getLastUserPreview(conversation) }}
              </button>
              <div class="flex shrink-0 items-center gap-0.5 opacity-100 transition-colors sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                <button type="button" class="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-subtle hover:bg-accent-soft hover:text-accent" title="编辑标题" @click="renameConversation(conversation)"><Edit3 :size="12" /></button>
                <button type="button" class="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-subtle hover:bg-accent-soft hover:text-accent" :title="conversation.pinned ? '取消置顶' : '置顶'" @click="workspaceStore.togglePinAiAssistantConversation(conversation.id)"><Pin :size="12" /></button>
                <button type="button" class="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-subtle hover:bg-warning/10 hover:text-warning" :title="conversation.favorite ? '取消收藏' : '收藏'" @click="toggleFavorite(conversation)"><Star :size="12" /></button>
                <button v-if="conversation.favorite" type="button" class="hidden h-6 items-center rounded-md px-1.5 text-[10px] text-text-subtle hover:bg-warning/10 hover:text-warning md:inline-flex" @click="editFavoriteCategory(conversation)">分类</button>
                <button type="button" class="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-subtle hover:bg-accent-soft hover:text-accent" :title="conversation.archived ? '取消归档' : '归档'" @click="workspaceStore.toggleArchiveAiAssistantConversation(conversation.id)"><Archive :size="12" /></button>
                <button type="button" class="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-subtle hover:bg-danger/10 hover:text-danger" title="删除" @click="deleteConversation(conversation)"><Trash2 :size="12" /></button>
              </div>
            </div>
          </div>

          <div class="flex self-stretch flex-col items-end justify-between py-0.5 text-[10px] text-text-subtle">
            <span class="inline-flex items-center gap-1 whitespace-nowrap"><Clock3 :size="11" />{{ formatTime(conversation.updatedAt) }}</span>
            <span class="inline-flex items-center gap-1 whitespace-nowrap"><MessageSquare :size="11" />{{ conversation.messages.length }} 条消息</span>
          </div>
        </article>
      </div>

      <div class="mt-3 flex items-center justify-between gap-3 px-1 text-[11px] text-text-subtle">
        <span class="hidden sm:inline">每页 {{ PAGE_SIZE }} 条</span>
        <div class="ml-auto flex items-center gap-1">
          <button type="button" class="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border-soft text-text-muted disabled:cursor-not-allowed disabled:opacity-40" :disabled="currentPage === 1" title="上一页" @click="setPage(currentPage - 1)"><ChevronLeft :size="14" /></button>
          <button
            v-for="page in visiblePages"
            :key="page"
            type="button"
            class="h-7 min-w-7 rounded-lg border px-2 text-xs"
            :class="currentPage === page ? 'border-accent bg-accent text-white' : 'border-border-soft text-text-muted hover:text-text-main'"
            @click="setPage(page)"
          >
            {{ page }}
          </button>
          <button type="button" class="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border-soft text-text-muted disabled:cursor-not-allowed disabled:opacity-40" :disabled="currentPage === totalPages" title="下一页" @click="setPage(currentPage + 1)"><ChevronRight :size="14" /></button>
        </div>
      </div>
    </div>
  </section>
</template>