<script setup lang="ts">
import { computed, ref, shallowRef, useId, watch, type ComponentPublicInstance } from 'vue'
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Edit3,
  Inbox,
  MessageSquare,
  Pin,
  Star,
  Trash2,
} from 'lucide-vue-next'
import { useWorkspaceStore, type AiAssistantConversation } from '@/renderer/stores/workspace'
import {
  normalizeAiAssistantFavoriteCategory,
  sortAiAssistantConversationsByUpdatedAt,
} from '@/renderer/stores/workspace-ai-utils'

const props = defineProps<{ searchQuery: string; scrollRoot: HTMLElement | null }>()
const workspaceStore = useWorkspaceStore()

type FilterKey = 'all' | 'favorite' | 'archived'

const BATCH_SIZE = 8
const searchTerm = computed(() => props.searchQuery.trim().toLowerCase())
const filter = ref<FilterKey>('all')
const categoryFilter = ref('all')
const startDate = ref('')
const endDate = ref('')
const invalidRange = computed(() => Boolean(startDate.value && endDate.value && endDate.value < startDate.value))
const batchMode = ref(false)
const batchBusy = ref(false)
const selectedIds = ref(new Set<string>())
const batchAction = ref('')
const visibleLimit = ref(BATCH_SIZE)
const timelineEnd = shallowRef<HTMLElement | null>(null)
const setTimelineEnd = (element: Element | ComponentPublicInstance | null) => {
  timelineEnd.value = element as HTMLElement | null
}
const pinnedRowsId = useId()
const browsePinsExpanded = ref(true)
const searchPinsExpanded = ref(true)
const pinsExpanded = computed(() => searchTerm.value ? searchPinsExpanded.value : browsePinsExpanded.value)

const togglePins = () => {
  const expanded = searchTerm.value ? searchPinsExpanded : browsePinsExpanded
  expanded.value = !expanded.value
}

watch(searchTerm, () => {
  searchPinsExpanded.value = true
})

const filters: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'favorite', label: '收藏' },
  { key: 'archived', label: '归档' },
]
const batchActions = [
  { key: 'favorite', label: '收藏' }, { key: 'unfavorite', label: '取消收藏' },
  { key: 'archive', label: '归档' }, { key: 'unarchive', label: '取消归档' },
  { key: 'delete', label: '删除' },
]

const conversations = computed(() => sortAiAssistantConversationsByUpdatedAt(workspaceStore.aiAssistant.conversations))
const isPinnedAbove = (conversation: AiAssistantConversation) => conversation.pinned && !conversation.archived
const datedConversations = computed(() => conversations.value.filter(conversation => !isPinnedAbove(conversation)))
const favoriteCategories = computed(() => {
  const categories = datedConversations.value
    .map((conversation) => conversation.favoriteCategory?.trim())
    .filter((value): value is string => Boolean(value))
  return Array.from(new Set(categories)).sort((a, b) => a.localeCompare(b, 'zh-CN'))
})

const getLastUserQuestion = (conversation: AiAssistantConversation) => {
  const userMessage = [...conversation.messages].reverse().find((message) => message.role === 'user' && message.text.trim())
  return userMessage?.text.trim().replace(/\s+/g, ' ') ?? ''
}

const hourFormatter = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const weekdayFormatter = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' })
const getLocalDay = (date: Date) => Number.isFinite(date.getTime())
  ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  : ''
const formatTime = (timestamp: number, includeDay: boolean) => {
  const date = new Date(timestamp)
  const day = getLocalDay(date)
  return day ? `${includeDay ? `${day} · ` : ''}${hourFormatter.format(date)}` : '—'
}

const searchMatches = computed(() => {
  const term = searchTerm.value
  return term ? conversations.value.filter(conversation => conversation.title.toLowerCase().includes(term)
    || getLastUserQuestion(conversation).toLowerCase().includes(term)) : conversations.value
})
const pinnedConversations = computed(() => searchMatches.value.filter(isPinnedAbove)
  .sort((a, b) => (b.pinnedAt ?? b.updatedAt) - (a.pinnedAt ?? a.updatedAt) || b.updatedAt - a.updatedAt))

const matchesFilter = (conversation: AiAssistantConversation, key: FilterKey) => {
  if (key === 'archived') return Boolean(conversation.archived)
  if (conversation.archived) return false
  if (key === 'favorite') return Boolean(conversation.favorite)
  return true
}
const filterCounts = computed(() => Object.fromEntries(filters.map(({ key }) => [
  key, datedConversations.value.filter(conversation => matchesFilter(conversation, key)).length,
])))
const matchesDateRange = (conversation: AiAssistantConversation) => {
  if (!startDate.value && !endDate.value) return true
  if (invalidRange.value) return false
  const day = getLocalDay(new Date(conversation.updatedAt))
  return Boolean(day && (!startDate.value || day >= startDate.value) && (!endDate.value || day <= endDate.value))
}
const filteredConversations = computed(() => searchTerm.value
  ? searchMatches.value.filter(conversation => !isPinnedAbove(conversation))
  : datedConversations.value.filter(conversation => matchesFilter(conversation, filter.value)
    && (categoryFilter.value === 'all' || conversation.favoriteCategory === categoryFilter.value)
    && matchesDateRange(conversation)))
const showEmpty = computed(() => (searchTerm.value ? searchMatches.value : filteredConversations.value).length === 0)

const hasMore = computed(() => visibleLimit.value < filteredConversations.value.length)
const loadOlderConversations = () => {
  if (hasMore.value) {
    visibleLimit.value = Math.min(visibleLimit.value + BATCH_SIZE, filteredConversations.value.length)
  }
}
const visibleConversationRows = computed(() => filteredConversations.value.slice(0, visibleLimit.value))
const batchSelectableIds = computed(() => new Set(visibleConversationRows.value
  .filter(conversation => !conversation.pinned).map(conversation => conversation.id)))
const isBatchSelectable = (id: string) => batchMode.value && batchSelectableIds.value.has(id)
const timelineGroups = computed(() => {
  const groups = new Map<string, { key: string; label: string; detail: string; conversations: AiAssistantConversation[] }>()
  for (const conversation of visibleConversationRows.value) {
    const date = new Date(conversation.updatedAt)
    const key = getLocalDay(date)
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        label: key ? key.slice(5).replace('-', '/') : '未知日期',
        detail: key ? `${date.getFullYear()} · ${weekdayFormatter.format(date)}` : '',
        conversations: [],
      }
      groups.set(key, group)
    }
    group.conversations.push(conversation)
  }
  return [...groups.values()]
})
const pinnedGroup = computed(() => pinnedConversations.value.length ? [{
  key: 'pinned', label: '置顶对话', detail: '按置顶时间排列', conversations: pinnedConversations.value,
}] : [])
const sections = computed(() => [
  { key: 'pinned', pinned: true, groups: pinnedGroup.value },
  { key: 'timeline', pinned: false, groups: timelineGroups.value },
].filter(section => !section.pinned || section.groups.length > 0))
const workspaceScope = [() => workspaceStore.activeWorkspaceId, () => workspaceStore.aiAssistantLoadRequestId] as const
const timelineScope = [searchTerm, filter, categoryFilter, startDate, endDate, ...workspaceScope] as const
watch(timelineScope, () => {
  visibleLimit.value = BATCH_SIZE
  selectedIds.value.clear()
})

watch(batchSelectableIds, (eligibleIds) => {
  for (const id of selectedIds.value) {
    if (!eligibleIds.has(id)) selectedIds.value.delete(id)
  }
})

// Re-arm after append so a tall viewport can load again even if the end never leaves view.
watch([() => props.scrollRoot, timelineEnd, visibleLimit, ...timelineScope], ([root, end], _, onCleanup) => {
  if (!root || !end || typeof IntersectionObserver === 'undefined') return
  let active = true
  const observer = new IntersectionObserver((entries) => {
    if (!active || !entries.some(entry => entry.isIntersecting)) return
    active = false
    loadOlderConversations()
  }, { root })
  observer.observe(end)
  onCleanup(() => {
    active = false
    observer.disconnect()
  })
}, { flush: 'post' })

watch(favoriteCategories, (categories) => {
  if (categoryFilter.value !== 'all' && !categories.includes(categoryFilter.value)) {
    categoryFilter.value = 'all'
  }
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
}

const toggleBatchMode = () => {
  batchMode.value = !batchMode.value
  selectedIds.value.clear()
  batchAction.value = ''
}

const toggleBatchSelection = (id: string) => {
  if (batchBusy.value) return
  if (!selectedIds.value.delete(id)) selectedIds.value.add(id)
}

const handleConversationRowClick = (event: MouseEvent, id: string) => {
  if (!isBatchSelectable(id) || (event.target as Element | null)?.closest('button')) return
  toggleBatchSelection(id)
}

const handleConversationRowKeydown = (event: KeyboardEvent, id: string) => {
  if (!isBatchSelectable(id) || batchBusy.value || (event.key !== ' ' && event.key !== 'Enter')) return
  event.preventDefault()
  if (!event.repeat) toggleBatchSelection(id)
}

const runBatchAction = async () => {
  if (batchBusy.value || !batchAction.value || !selectedIds.value.size) return
  const ids = [...selectedIds.value].filter(id => batchSelectableIds.value.has(id))
  if (!ids.length) return
  const stillUnpinnedIds = () => {
    const unpinnedIds = new Set(workspaceStore.aiAssistant.conversations
      .filter(conversation => !conversation.pinned).map(conversation => conversation.id))
    return ids.filter(id => unpinnedIds.has(id))
  }
  const workspaceId = workspaceStore.activeWorkspaceId
  const loadId = workspaceStore.aiAssistantLoadRequestId
  const sameScope = () => workspaceId === workspaceStore.activeWorkspaceId && loadId === workspaceStore.aiAssistantLoadRequestId
  const action = batchAction.value
  batchBusy.value = true
  try {
    if (action === 'delete') {
      const ok = await workspaceStore.requestConfirmation({
        title: '批量删除对话',
        message: `删除已选的 ${ids.length} 条对话？此操作不可恢复。`,
        confirmText: '删除',
        danger: true,
      })
      if (!ok || !sameScope()) return
      const eligibleIds = stillUnpinnedIds()
      if (eligibleIds.length) workspaceStore.deleteAiAssistantConversations(eligibleIds)
    } else if (action === 'favorite') {
      const next = await workspaceStore.requestTextInput('批量收藏分类', '默认收藏', '例如：论文 / 项目 / 灵感')
      const category = normalizeAiAssistantFavoriteCategory(next)
      if (category === null || !sameScope()) return
      const eligibleIds = stillUnpinnedIds()
      if (eligibleIds.length) workspaceStore.setAiAssistantConversationFlags(eligibleIds, { favorite: true, category })
    } else if (action === 'archive' || action === 'unarchive') {
      workspaceStore.setAiAssistantConversationFlags(ids, { archived: action === 'archive' })
    } else if (action === 'unfavorite') {
      workspaceStore.setAiAssistantConversationFlags(ids, { favorite: false })
    }
    selectedIds.value.clear()
  } finally {
    batchBusy.value = false
  }
}
</script>

<template>
  <section aria-label="历史对话列表">
    <section v-for="section in sections" :key="section.key"
      :aria-label="section.pinned ? '置顶对话' : '日期列表'"
      :class="section.pinned ? 'mb-5 rounded-xl border border-border-soft bg-accent-soft/45 px-3 py-2.5' : ''"
    >
      <template v-if="!section.pinned">
    <div v-if="!searchTerm" class="flex flex-wrap items-center gap-2 border-y border-border-soft py-2.5">
      <div role="group" aria-label="对话状态筛选" class="flex flex-wrap items-center gap-2">
        <button
          v-for="item in filters"
          :key="item.key"
          type="button"
          class="h-9 rounded-lg border px-3 text-xs font-medium transition-colors"
          :class="filter === item.key ? 'border-accent bg-accent-soft text-accent' : 'border-border-soft bg-panel text-text-muted hover:text-text-main'"
          :aria-pressed="filter === item.key"
          @click="filter = item.key"
        >
          {{ item.label }} <span class="tabular-nums">{{ filterCounts[item.key] }}</span>
        </button>
        <select
          v-model="categoryFilter"
          aria-label="收藏分类"
          class="h-9 max-w-full rounded-lg border border-border-soft bg-panel-soft px-3 text-xs text-text-muted"
        >
          <option value="all">全部分类</option>
          <option v-for="category in favoriteCategories" :key="category" :value="category">
            {{ category }}
          </option>
        </select>
      </div>
      <div role="group" aria-label="最后更新日期区间" class="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <span>更新日期</span>
        <input v-model="startDate" type="date" aria-label="开始日期" :aria-invalid="invalidRange" class="history-date-input">
        <span aria-hidden="true">至</span>
        <input v-model="endDate" type="date" aria-label="结束日期" :aria-invalid="invalidRange" class="history-date-input">
        <button v-if="startDate || endDate" type="button" class="rounded-md px-2 py-1 hover:bg-panel-soft" @click="startDate = ''; endDate = ''">清除日期</button>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 text-xs text-text-muted">
      <button type="button" :aria-pressed="batchMode" :disabled="batchBusy" class="history-batch-button" @click="toggleBatchMode">{{ batchMode ? '退出批量操作' : '批量操作' }}</button>
      <template v-if="batchMode">
        <span role="status">已选 {{ selectedIds.size }} 项</span>
        <select v-model="batchAction" aria-label="批量操作类型" :disabled="batchBusy" class="history-batch-button">
          <option disabled value="">选择操作</option>
          <option v-for="action in batchActions" :key="action.key" :value="action.key">{{ action.label }}</option>
        </select>
        <button type="button" :disabled="!selectedIds.size || !batchAction || batchBusy" class="history-batch-button" @click="runBatchAction">执行</button>
      </template>
      <span v-if="searchTerm" role="status" class="ml-auto">全部对话中找到 {{ searchMatches.length }} 个结果</span>
      <span v-else class="ml-auto">共 {{ filteredConversations.length }} 个对话</span>
    </div>

    <p v-if="!searchTerm && invalidRange" role="status" class="py-2 text-sm text-danger">结束日期不能早于开始日期</p>
    <div v-else-if="showEmpty" class="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-border-soft bg-panel/70 p-10 text-center text-text-muted">
      <Inbox :size="42" class="mb-3 text-text-subtle" />
      <div class="text-sm font-medium text-text-main">暂无匹配的历史对话</div>
      <p v-if="conversations.length === 0" class="mt-1 text-xs text-text-subtle">发送第一条问题后，正式对话才会出现在这里。</p>
    </div>
      </template>

      <div v-for="group in section.groups" :key="group.key" :class="section.pinned ? '' : 'history-day'">
        <h2 v-if="section.pinned" class="text-sm font-semibold text-accent">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent"
            :aria-expanded="pinsExpanded"
            :aria-controls="pinnedRowsId"
            @click="togglePins"
          >
            <ChevronDown v-if="pinsExpanded" :size="14" class="shrink-0" aria-hidden="true" />
            <ChevronRight v-else :size="14" class="shrink-0" aria-hidden="true" />
            <Pin :size="14" class="shrink-0" aria-hidden="true" />{{ group.label }} · {{ group.conversations.length }}
            <span class="ml-auto text-[11px] font-normal text-text-muted">{{ group.detail }}</span>
          </button>
        </h2>
        <h2 v-else class="history-date">
          <time v-if="group.key" :datetime="group.key">{{ group.label }}</time>
          <span v-else>{{ group.label }}</span>
          <small v-if="group.detail">{{ group.detail }}</small>
        </h2>
        <div :id="section.pinned ? pinnedRowsId : undefined" class="min-w-0">
        <article
          v-for="conversation in section.pinned && !pinsExpanded ? [] : group.conversations"
          :key="conversation.id"
          class="group history-row grid items-start gap-x-2 border-t border-border-soft px-1.5 py-2.5 transition-colors hover:bg-panel"
          :class="[isBatchSelectable(conversation.id) ? 'grid-cols-[minmax(0,1fr)_minmax(2.25rem,14%)_auto]' : 'grid-cols-[minmax(0,1fr)_auto]', { 'bg-success/5': isBatchSelectable(conversation.id) && selectedIds.has(conversation.id), 'cursor-pointer': isBatchSelectable(conversation.id) && !batchBusy }]"
          :tabindex="isBatchSelectable(conversation.id) ? 0 : undefined"
          :aria-label="isBatchSelectable(conversation.id) ? `${conversation.title}，${selectedIds.has(conversation.id) ? '已选中' : '未选中'}` : undefined"
          :aria-keyshortcuts="isBatchSelectable(conversation.id) ? 'Enter Space' : undefined"
          @click="handleConversationRowClick($event, conversation.id)"
          @keydown.self="handleConversationRowKeydown($event, conversation.id)"
        >
          <div class="min-w-0">
            <div class="flex min-w-0 items-center gap-1.5">
              <button type="button" class="truncate text-left text-sm font-semibold text-text-main hover:text-accent" @click="selectConversation(conversation.id)">
                {{ conversation.title }}
              </button>
              <span v-if="conversation.pinned && !section.pinned" class="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] text-accent">置顶</span>
              <span v-if="conversation.favorite" class="max-w-[40%] truncate rounded-full bg-warning/10 px-1.5 py-0.5 text-[9px]" :title="conversation.favoriteCategory">{{ conversation.favoriteCategory || '收藏' }}</span>
              <span v-if="conversation.archived" class="shrink-0 rounded-full bg-panel px-1.5 py-0.5 text-[9px] text-text-muted">归档</span>
            </div>
            <div class="mt-1 flex min-w-0 items-center gap-2">
              <button type="button" class="min-w-0 truncate text-left text-xs text-text-muted hover:text-text-main" :class="{ 'flex-1': !isBatchSelectable(conversation.id) }" @click="selectConversation(conversation.id)">
                {{ getLastUserQuestion(conversation) || '暂无用户问题' }}
              </button>
            </div>
          </div>

          <div v-if="isBatchSelectable(conversation.id)" class="history-selection-mark" aria-hidden="true">
            <svg v-if="selectedIds.has(conversation.id)" class="history-crayon-check" viewBox="0 0 34 26" fill="none" aria-hidden="true">
              <path d="M4 13.4 6.2 12.7 12.7 18.9 15.6 15.5 21.5 9.1 27.4 4.9 31.1 4 29.7 7.4 25.9 10.3 20 16 13.9 23 11.8 23.1 8.9 20.3 5.5 16.6Z" fill="currentColor" opacity=".42" />
              <path d="m5.5 14.6 7.2 6.7 2.5-2.6 6.2-7.1 8.2-6.2" stroke="currentColor" stroke-width="2.9" stroke-linecap="round" stroke-linejoin="round" />
              <path d="m5.3 12.8 7.4 7.1 8.2-9.3 9-6.3M6.5 16.7l6.2 5.7 2.8-2.8 6.7-7.4 8.7-6.7" stroke="currentColor" stroke-width=".9" stroke-linecap="round" stroke-dasharray="1.5 1.15 .65 1.1" opacity=".86" />
            </svg>
          </div>

          <div class="flex flex-col items-end gap-0.5 whitespace-nowrap text-text-muted">
            <time class="tabular-nums text-accent" :class="section.pinned ? 'text-[10px] font-medium sm:text-xs' : 'history-hour'"
              :title="`最后更新：${formatTime(conversation.updatedAt, true)}`"
            >{{ formatTime(conversation.updatedAt, section.pinned) }}</time>
            <span class="inline-flex items-center gap-1 text-[10px]"><MessageSquare :size="11" />{{ conversation.messages.length }} 条消息</span>
          </div>

              <div class="history-actions col-span-full flex flex-wrap items-center justify-end gap-0.5">
                <button type="button" class="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-subtle hover:bg-accent-soft hover:text-accent" title="编辑标题" @click="renameConversation(conversation)"><Edit3 :size="12" /></button>
                <button type="button" class="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-subtle hover:bg-accent-soft hover:text-accent" :title="conversation.pinned ? '取消置顶' : '置顶'" @click="workspaceStore.togglePinAiAssistantConversation(conversation.id)"><Pin :size="12" /></button>
                <button type="button" class="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-subtle hover:bg-warning/10 hover:text-warning" :title="conversation.favorite ? '取消收藏' : '收藏'" @click="toggleFavorite(conversation)"><Star :size="12" /></button>
                <button v-if="conversation.favorite" type="button" class="inline-flex h-6 items-center rounded-md px-1.5 text-[10px] text-text-muted hover:bg-warning/10" @click="editFavoriteCategory(conversation)">分类</button>
                <button type="button" class="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-subtle hover:bg-accent-soft hover:text-accent" :title="conversation.archived ? '取消归档' : '归档'" @click="workspaceStore.toggleArchiveAiAssistantConversation(conversation.id)"><Archive :size="12" /></button>
                <button type="button" class="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-subtle hover:bg-danger/10 hover:text-danger" title="删除" @click="deleteConversation(conversation)"><Trash2 :size="12" /></button>
              </div>
        </article>
        </div>
      </div>

      <template v-if="!section.pinned">
        <div v-if="hasMore" :ref="setTimelineEnd" class="mt-3 flex justify-center text-xs text-text-muted">
          <button type="button" class="rounded-lg px-3 py-2 hover:bg-panel-soft hover:text-text-main" @click="loadOlderConversations">加载更早对话</button>
        </div>
        <p v-else-if="filteredConversations.length" class="mt-3 py-2 text-center text-xs text-text-muted">已显示全部对话</p>
      </template>
    </section>
  </section>
</template>

<style scoped>
.history-date-input,
.history-batch-button {
  min-height: 2rem;
  border: 1px solid var(--border-soft);
  border-radius: 0.5rem;
  background: var(--panel-soft);
  color: var(--text-main);
  padding: 0.25rem 0.55rem;
}

.history-batch-button:disabled { opacity: 0.5; }
.history-batch-button:not(:disabled):hover { background: var(--accent-soft); }

.history-selection-mark {
  display: grid;
  place-items: center;
  align-self: stretch;
  min-height: 2.25rem;
  pointer-events: none;
  color: var(--history-check-green, #347344);
}

.history-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

.history-crayon-check {
  width: 1.8rem;
  height: 1.4rem;
  transform: rotate(-7deg);
}

:global([data-theme="dark"]) .history-selection-mark { --history-check-green: #8cd69a; }

.history-day {
  display: grid;
  grid-template-columns: clamp(3.8rem, 18%, 7rem) minmax(0, 1fr);
  column-gap: clamp(0.45rem, 2.5%, 1.25rem);
}

.history-date {
  position: relative;
  border-right: 1px solid var(--border-soft);
  padding: 0.55rem 0.4rem 0.75rem 0;
  color: var(--accent);
  font-family: Georgia, serif;
  font-size: clamp(1.05rem, 2.4vw, 1.7rem);
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.history-date::after {
  content: '';
  position: absolute;
  top: 1rem;
  right: -4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}

.history-date small {
  display: block;
  margin-top: 0.25rem;
  color: var(--text-muted);
  font: 0.65rem/1.4 var(--font-ui);
}

.history-date time {
  white-space: nowrap;
}

.history-hour {
  font: 1.25rem/1.1 Georgia, serif;
}

@media (hover: hover) and (pointer: fine) {
  .history-actions { opacity: 0; }
  .history-row:hover .history-actions,
  .history-row:focus-within .history-actions { opacity: 1; }
}
</style>