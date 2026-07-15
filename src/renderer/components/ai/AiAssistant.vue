<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Bot, Clipboard, Copy, Database, History, Loader2, MessageSquare, Plus, RotateCcw, Send, Settings, Sparkles, Square, Workflow } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import { useSettingsStore } from '@/renderer/stores/settings'
import { useAiAssistantStore } from '@/renderer/stores/ai-assistant'
import { normalizeAiAssistantSourcePath } from '@/renderer/stores/workspace-ai-utils'
import type { AiAssistantMessage, AiAssistantMessageAction, AiAssistantTimelineOutput } from '@/renderer/stores/workspace'
import type { AgentMode } from '@/shared/utils/app-settings'
import AiMarkdown from './AiMarkdown.vue'
import AgentModeSwitch from './AgentModeSwitch.vue'
import AgentTimelineDrawer from './AgentTimelineDrawer.vue'
import { deriveAgentUiState } from './agentUiState'

const workspaceStore = useWorkspaceStore()
const settingsStore = useSettingsStore()
const aiAssistStore = useAiAssistantStore()
const BUILD_INDEX_ACTION_TYPE: AiAssistantMessageAction['type'] = 'build-index'
const MISSING_INDEX_MESSAGE = '为了让 Looma AI 能检索你的笔记，需要先为当前工作空间建立本地索引。'
const checkedHasIndex = ref(false)
const isCheckingIndex = ref(false)
const messagesRef = ref<HTMLElement | null>(null)
const composerRef = ref<HTMLTextAreaElement | null>(null)
const contextMenuRef = ref<HTMLElement | null>(null)
const copiedMessageId = ref<number | null>(null)
const selectedMode = ref<AgentMode>('rag')
const hasInitializedMode = ref(false)
const drawerOpen = ref(false)
const drawerMessageId = ref<number | undefined>()
const aiContextMenu = ref({
  visible: false,
  top: 0,
  left: 0,
  source: null as 'messages' | 'composer' | null,
  selectedText: '',
})

const hasWorkspace = computed(() => Boolean(workspaceStore.activeWorkspaceId))
const activeConversation = computed(() => workspaceStore.activeAiAssistantConversation)
const activeConversationId = computed(() => workspaceStore.aiAssistant.activeConversationId)
const messages = computed(() => activeConversation.value.messages)
const isAsking = computed(() => aiAssistStore.isConversationAsking(activeConversationId.value))
const isAgentRunning = computed(() => aiAssistStore.isConversationRunningAgent(activeConversationId.value))
const isAnyConversationRunning = computed(() => (
  Object.keys(aiAssistStore.streamsByConversationId).length > 0
  || Object.keys(aiAssistStore.ragStartingConversationIds).length > 0
  || Object.keys(aiAssistStore.agentRunsByConversationId).length > 0
  || Object.keys(aiAssistStore.agentStartingConversationIds).length > 0
))
const isGenerating = computed(() => isAsking.value || isAgentRunning.value)
const isIndexing = computed(() => aiAssistStore.isWorkspaceIndexing(workspaceStore.activeWorkspaceId))
const hasIndex = computed(() => aiAssistStore.getWorkspaceIndexResult(workspaceStore.activeWorkspaceId)?.exists ?? checkedHasIndex.value)
const question = computed({
  get: () => activeConversation.value.draft,
  set: (value: string) => workspaceStore.setAiAssistantDraft(value),
})
const modeNeedsIndex = computed(() => selectedMode.value === 'rag')
const canAsk = computed(() => (
  hasWorkspace.value
  && (!modeNeedsIndex.value || hasIndex.value)
  && (!modeNeedsIndex.value || (!isCheckingIndex.value && !isIndexing.value))
  && !isGenerating.value
  && question.value.trim().length > 0
))
const canAskWithText = computed(() => (
  hasWorkspace.value
  && (!modeNeedsIndex.value || hasIndex.value)
  && (!modeNeedsIndex.value || (!isCheckingIndex.value && !isIndexing.value))
  && !isGenerating.value
))
const inputPlaceholder = computed(() => {
  if (!hasWorkspace.value) return '请先打开工作空间'
  if (modeNeedsIndex.value && isCheckingIndex.value) return '正在检查索引...'
  if (modeNeedsIndex.value && !hasIndex.value) return '请先建立索引'
  if (modeNeedsIndex.value && isIndexing.value) return '正在建立索引...'
  if (isGenerating.value) return selectedMode.value === 'agent' ? 'Agent 正在执行...' : '正在思考...'
  return selectedMode.value === 'agent' ? '让 Agent 读取并分析当前工作空间' : '询问当前工作空间中的笔记'
})
const providerLabels: Record<string, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI Compatible',
  deepseek: 'DeepSeek',
  qwen: '通义千问',
  custom: '自定义 HTTP API',
}
const aiDisplayName = computed(() => {
  const chat = settingsStore.aiSettings.chat
  const provider = providerLabels[chat.provider] ?? chat.provider
  const model = chat.model?.trim() || '未选择模型'
  return `${provider} · ${model}`
})
const getMessageAiName = (message: AiAssistantMessage) => message.modelIdentity?.displayName || message.aiName?.trim() || 'Looma AI'
const drawerState = computed(() => deriveAgentUiState(messages.value, drawerMessageId.value))
const getMessageProcessState = (message: AiAssistantMessage) => deriveAgentUiState([message], message.id)

const openProcessDrawer = (message: AiAssistantMessage) => {
  drawerMessageId.value = message.id
  drawerOpen.value = true
}

const scrollToBottom = () => {
  nextTick(() => {
    messagesRef.value?.scrollTo({ top: messagesRef.value.scrollHeight, behavior: 'smooth' })
  })
}

const appendMessage = (role: 'assistant' | 'user' | 'system', text: string, actions?: AiAssistantMessageAction[], meta?: { aiName?: string }) => {
  const id = workspaceStore.appendAiAssistantMessage(role, text, actions, meta)
  scrollToBottom()
  return id
}

const appendToDraft = (text: string) => {
  const value = text.trim()
  if (!value) return
  const current = question.value.trimEnd()
  question.value = current ? `${current}\n\n${value}` : value
  nextTick(() => composerRef.value?.focus())
}

const closeAiContextMenu = () => {
  aiContextMenu.value.visible = false
}

const getContainedSelectionText = (container: HTMLElement | null) => {
  if (!container) return ''
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return ''

  const range = selection.getRangeAt(0)
  const ancestor = range.commonAncestorContainer
  const node = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement
  if (!node || !container.contains(node)) return ''

  return selection.toString().trim()
}

const getComposerSelectedText = () => {
  const textarea = composerRef.value
  if (!textarea) return ''
  const start = textarea.selectionStart ?? 0
  const end = textarea.selectionEnd ?? 0
  if (start === end) return ''
  return textarea.value.slice(Math.min(start, end), Math.max(start, end)).trim()
}

const positionAiContextMenu = (event: MouseEvent) => {
  aiContextMenu.value.left = event.clientX
  aiContextMenu.value.top = event.clientY

  nextTick(() => {
    const menu = contextMenuRef.value
    if (!menu || !aiContextMenu.value.visible) return

    const rect = menu.getBoundingClientRect()
    const margin = 8
    aiContextMenu.value.left = Math.min(event.clientX, window.innerWidth - rect.width - margin)
    aiContextMenu.value.top = Math.min(event.clientY, window.innerHeight - rect.height - margin)
    aiContextMenu.value.left = Math.max(margin, aiContextMenu.value.left)
    aiContextMenu.value.top = Math.max(margin, aiContextMenu.value.top)
  })
}

const openMessagesContextMenu = (event: MouseEvent) => {
  const selectedText = getContainedSelectionText(messagesRef.value)
  if (!selectedText) return

  event.preventDefault()
  aiContextMenu.value = {
    visible: true,
    top: event.clientY,
    left: event.clientX,
    source: 'messages',
    selectedText,
  }
  positionAiContextMenu(event)
}

const openComposerContextMenu = (event: MouseEvent) => {
  event.preventDefault()
  aiContextMenu.value = {
    visible: true,
    top: event.clientY,
    left: event.clientX,
    source: 'composer',
    selectedText: getComposerSelectedText(),
  }
  positionAiContextMenu(event)
}

const copySelectedContextText = async () => {
  const text = aiContextMenu.value.selectedText.trim()
  if (!text) return
  await navigator.clipboard.writeText(text)
  closeAiContextMenu()
}

const pasteIntoComposer = async () => {
  if (aiContextMenu.value.source !== 'composer') return
  const text = await navigator.clipboard.readText()
  appendToDraft(text)
  closeAiContextMenu()
}

const addSelectionToComposer = () => {
  if (aiContextMenu.value.source !== 'messages') return
  appendToDraft(aiContextMenu.value.selectedText)
  closeAiContextMenu()
}

const explainSelection = async () => {
  if (aiContextMenu.value.source !== 'messages') return
  const selectedText = aiContextMenu.value.selectedText.trim()
  if (!selectedText) return

  const prompt = `请解释以下内容：\n\n${selectedText}`
  closeAiContextMenu()

  if (!canAskWithText.value) {
    appendToDraft(prompt)
    return
  }

  question.value = prompt
  await nextTick()
  askQuestion().catch(console.error)
}

const handleDocumentClick = (event: MouseEvent) => {
  if (!aiContextMenu.value.visible) return
  if (contextMenuRef.value?.contains(event.target as Node)) return
  closeAiContextMenu()
}

const getTimelineSourcePath = (output: AiAssistantTimelineOutput) => {
  const metadata = output.metadata || {}
  const path = output.path
    || (typeof metadata.source === 'string' ? metadata.source : '')
    || (typeof metadata.file_path === 'string' ? metadata.file_path : '')
    || (typeof metadata.path === 'string' ? metadata.path : '')
  return normalizeAiAssistantSourcePath(path, workspaceStore.activeWorkspace?.path)
}

const openTimelineSource = (output: AiAssistantTimelineOutput) => {
  const path = getTimelineSourcePath(output)
  if (!path) return
  workspaceStore.setActiveFileRelative(path)
}

const getActiveWorkspaceId = () => {
  const workspaceId = workspaceStore.activeWorkspaceId
  if (!workspaceId) {
    appendMessage('system', '请先打开一个工作空间。')
    return null
  }
  return workspaceId
}

const openIndexLibrary = () => {
  const workspaceId = getActiveWorkspaceId()
  if (!workspaceId) return
  workspaceStore.openRagIndexPage()
}

const createBuildIndexAction = (disabled = false): AiAssistantMessageAction => ({
  type: BUILD_INDEX_ACTION_TYPE,
  title: '建立当前工作空间索引',
  description: '索引只保存在本机。建立完成后，Looma AI 就可以基于当前工作空间回答你的问题。',
  buttonText: '建立索引',
  disabled,
})

const hasBuildIndexPrompt = () =>
  messages.value.some((message) =>
    message.text === MISSING_INDEX_MESSAGE
    || message.actions?.some((action) => action.type === BUILD_INDEX_ACTION_TYPE),
  )

const ensureBuildIndexPrompt = () => {
  if (hasBuildIndexPrompt()) return
  appendMessage('system', MISSING_INDEX_MESSAGE, [createBuildIndexAction(false)])
}

const setBuildIndexActionsDisabled = (disabled: boolean) => {
  workspaceStore.setAiAssistantActionDisabled(BUILD_INDEX_ACTION_TYPE, disabled)
}

const checkIndexStatus = async () => {
  const workspaceId = workspaceStore.activeWorkspaceId
  checkedHasIndex.value = false
  if (!workspaceId) return

  isCheckingIndex.value = true
  try {
    const result = await window.electronAPI.rag.status(workspaceId)
    if (workspaceStore.activeWorkspaceId !== workspaceId) return
    if (!result.success) {
      setBuildIndexActionsDisabled(false)
      if (selectedMode.value === 'rag') ensureBuildIndexPrompt()
      console.warn(result.error || '检查索引状态失败。')
      return
    }

    checkedHasIndex.value = Boolean(result.data?.exists)
    aiAssistStore.setWorkspaceIndexResult(workspaceId, { exists: checkedHasIndex.value, documentCount: 0 })
    if (hasIndex.value) {
      setBuildIndexActionsDisabled(true)
    } else {
      setBuildIndexActionsDisabled(false)
      if (selectedMode.value === 'rag') ensureBuildIndexPrompt()
    }
  } finally {
    isCheckingIndex.value = false
  }
}

const indexWorkspace = async () => {
  const workspaceId = getActiveWorkspaceId()
  if (!workspaceId || isIndexing.value || hasIndex.value) return

  setBuildIndexActionsDisabled(true)
  const conversationId = workspaceStore.ensureAiAssistantConversationForRequest()
  const result = await aiAssistStore.startWorkspaceIndex({ workspaceId, conversationId })
  if (!result?.success && result?.error) {
    setBuildIndexActionsDisabled(false)
    appendMessage('system', result.error)
  }
  scrollToBottom()
}

const askQuestion = async () => {
  const workspaceId = getActiveWorkspaceId()
  const text = question.value.trim()
  if (!workspaceId || !text || isGenerating.value) return
  if (selectedMode.value === 'rag' && !hasIndex.value) {
    ensureBuildIndexPrompt()
    return
  }

  const conversationId = workspaceStore.ensureAiAssistantConversationForRequest()
  if (selectedMode.value === 'agent') {
    drawerMessageId.value = undefined
    drawerOpen.value = true
  }
  const result = selectedMode.value === 'agent'
    ? await aiAssistStore.startAgentInConversation({
        workspaceId,
        conversationId,
        text,
        aiName: aiDisplayName.value,
      })
    : await aiAssistStore.askInConversation({
        workspaceId,
        conversationId,
        text,
        aiName: aiDisplayName.value,
      })
  if (!result?.success && result?.error) {
    appendMessage('system', result.error)
  }
  scrollToBottom()
}

const cancelCurrentGeneration = async () => {
  const conversationId = activeConversationId.value
  if (!conversationId) return
  if (isAgentRunning.value) {
    const result = await aiAssistStore.cancelAgentConversation(conversationId)
    if (result && !result.success) appendMessage('system', result.error || '取消 Agent 运行失败。')
  } else if (isAsking.value) {
    await aiAssistStore.cancelConversation(conversationId)
  }
}

const copyAssistantMessage = async (message: AiAssistantMessage) => {
  const text = message.text.trim()
  if (!text) return

  try {
    await navigator.clipboard.writeText(text)
    copiedMessageId.value = message.id
    window.setTimeout(() => {
      if (copiedMessageId.value === message.id) copiedMessageId.value = null
    }, 1400)
  } catch (error) {
    appendMessage('system', '复制失败，请检查浏览器剪贴板权限后重试。')
    console.error(error)
  }
}

const regenerateAssistantMessage = async (message: AiAssistantMessage) => {
  const workspaceId = getActiveWorkspaceId()
  const conversationId = activeConversationId.value
  if (!workspaceId || !conversationId || isGenerating.value || message.role !== 'assistant' || message.mode === 'agent') return
  if (!hasIndex.value) {
    ensureBuildIndexPrompt()
    return
  }

  const conversationMessages = messages.value
  const assistantIndex = conversationMessages.findIndex((item) => item.id === message.id)
  if (assistantIndex < 0) return

  let userIndex = -1
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const candidate = conversationMessages[index]
    if (candidate.role === 'user' && candidate.text.trim()) {
      userIndex = index
      break
    }
  }

  if (userIndex < 0) {
    appendMessage('system', '找不到这条回复对应的上一条用户问题，无法重新生成。')
    return
  }

  const userMessage = conversationMessages[userIndex]
  const result = await aiAssistStore.regenerateInConversation({
    workspaceId,
    conversationId,
    text: userMessage.text.trim(),
    assistantMessageId: message.id,
    sourceMessages: conversationMessages.slice(0, userIndex),
    aiName: aiDisplayName.value,
  })
  if (!result?.success && result?.error) appendMessage('system', result.error)
}

const handleComposerKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return

  event.preventDefault()
  if (canAsk.value) {
    askQuestion().catch(console.error)
  }
}

const runAction = (action: AiAssistantMessageAction) => {
  if (action.type === BUILD_INDEX_ACTION_TYPE) {
    indexWorkspace().catch(console.error)
  }
}

const isActionDisabled = (action: AiAssistantMessageAction) =>
  Boolean(action.disabled || hasIndex.value || isCheckingIndex.value || !hasWorkspace.value)

const isMessageStreaming = (message: AiAssistantMessage) => {
  const stream = aiAssistStore.getConversationStream(activeConversationId.value)
  const agentRun = aiAssistStore.getConversationAgentRun(activeConversationId.value)
  return Boolean(message.role === 'assistant' && (
    message.id === stream?.assistantMessageId || message.id === agentRun?.assistantMessageId
  ))
}

const backfillLegacyAiNames = () => {
  if (!settingsStore.isLoaded) return
  workspaceStore.backfillAiAssistantMessageNames(aiDisplayName.value)
}

const initializeMode = () => {
  if (!settingsStore.isLoaded || hasInitializedMode.value) return
  selectedMode.value = settingsStore.aiSettings.agent.defaultMode
  hasInitializedMode.value = true
}

const createConversation = () => {
  // AI/index request state is managed by aiAssistStore
  workspaceStore.startTemporaryAiAssistantConversation()
  scrollToBottom()
  nextTick(() => composerRef.value?.focus())
}

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
  aiAssistStore.ensureStreamEventSubscription()
  aiAssistStore.ensureAgentStreamEventSubscription()
  workspaceStore.removeAiAssistantMessagesByText(['Not Found'])
  initializeMode()
  backfillLegacyAiNames()
  scrollToBottom()
  checkIndexStatus().catch(console.error)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
})

watch(() => messages.value.length, scrollToBottom)
watch(() => workspaceStore.activeWorkspaceId, (_nextWorkspaceId, oldWorkspaceId) => {
  aiAssistStore.cancelWorkspaceStreams(oldWorkspaceId).catch(console.error)
  aiAssistStore.cancelWorkspaceIndex(oldWorkspaceId).catch(console.error)
  // AI/index request state is managed by aiAssistStore
  closeAiContextMenu()
  backfillLegacyAiNames()
  checkIndexStatus().catch(console.error)
})
watch(activeConversationId, () => {
  closeAiContextMenu()
  drawerMessageId.value = undefined
  drawerOpen.value = Boolean(isAgentRunning.value)
  backfillLegacyAiNames()
  if (selectedMode.value === 'rag' && !hasIndex.value && !isCheckingIndex.value && !workspaceStore.aiAssistant.isTemporaryConversation) {
    ensureBuildIndexPrompt()
  }
  scrollToBottom()
})
watch(() => settingsStore.isLoaded, () => {
  initializeMode()
  backfillLegacyAiNames()
})
watch(isAgentRunning, (running) => {
  if (!running) return
  const run = aiAssistStore.getConversationAgentRun(activeConversationId.value)
  drawerMessageId.value = run?.assistantMessageId
  drawerOpen.value = true
})
watch(selectedMode, (mode) => {
  if (mode === 'rag' && !hasIndex.value && !isCheckingIndex.value && !workspaceStore.aiAssistant.isTemporaryConversation) {
    ensureBuildIndexPrompt()
  }
})
</script>

<template>
  <div class="relative h-full min-h-0 overflow-hidden flex flex-col bg-panel text-text-main">
    <header class="shrink-0 border-b border-border-soft bg-panel px-4 py-3">
      <div class="flex items-center gap-3">
        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent shadow-sm">
          <Sparkles :size="18" />
        </div>
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-[15px] font-semibold leading-5 tracking-normal text-text-main">
            {{ aiDisplayName }}
          </h1>
          <p class="mt-0.5 truncate text-[11px] leading-4 text-text-muted">
            {{ activeConversation.title }}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
            <button
              class="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main"
              type="button"
              title="索引库"
              :disabled="!hasWorkspace"
              @click="openIndexLibrary"
            >
              <Database :size="16" />
            </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main"
            type="button"
            title="AI 设置"
            @click="workspaceStore.openSettingsPage('ai')"
          >
            <Settings :size="16" />
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main disabled:cursor-not-allowed disabled:text-text-subtle"
            type="button"
            title="历史对话"
            :disabled="!hasWorkspace"
            @click="workspaceStore.openAiHistoryPage()"
          >
            <History :size="16" />
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main disabled:cursor-not-allowed disabled:text-text-subtle"
            type="button"
            title="新建对话"
            :disabled="!hasWorkspace"
            @click="createConversation"
          >
            <Plus :size="16" />
          </button>
        </div>
      </div>
      <div class="mt-2.5 flex items-center justify-between gap-2">
        <AgentModeSwitch v-model="selectedMode" :disabled="isAnyConversationRunning" />
        <button
          type="button"
          class="inline-flex h-7 items-center gap-1.5 rounded-md border border-border-soft bg-panel px-2 text-[10px] text-text-muted transition-colors hover:bg-panel-soft hover:text-text-main disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!drawerState.message"
          :aria-expanded="drawerOpen"
          @click="drawerOpen = !drawerOpen"
        >
          <Workflow :size="12" />
          过程 {{ drawerState.timeline.length || '' }}
        </button>
      </div>
    </header>

    <div
      ref="messagesRef"
      class="min-h-0 flex-1 overflow-y-auto bg-panel-soft px-4 py-4"
      @contextmenu="openMessagesContextMenu"
      @scroll="closeAiContextMenu"
    >
      <div v-if="messages.length === 0" class="flex min-h-full items-center justify-center px-4 py-10 text-center">
        <div class="max-w-sm rounded-2xl border border-border-soft bg-panel p-5 shadow-sm">
          <div class="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Sparkles :size="18" />
          </div>
          <div class="text-sm font-semibold text-text-main">新对话</div>
          <p class="mt-2 text-xs leading-5 text-text-muted">
            发送消息给 AI 助手，Looma 会基于当前工作空间的内容回答你的问题。
          </p>
        </div>
      </div>
      <div v-else class="flex flex-col gap-4 text-sm">
        <div
          v-for="message in messages"
          :key="message.id"
          :class="[
            'flex',
            message.role === 'user'
              ? 'justify-end'
              : 'justify-center',
          ]"
        >
          <div
            :class="[
              message.role === 'user'
                ? 'max-w-[82%]'
                : 'w-full max-w-[90%]',
            ]"
          >
            <div
              v-if="message.role === 'system'"
              class="mb-2 flex items-center gap-2 px-1 text-center text-[10px] leading-4 text-text-subtle before:h-px before:flex-1 before:bg-border-soft after:h-px after:flex-1 after:bg-border-soft"
            >
              <span class="shrink-0">系统事件</span>
            </div>

            <div
              v-else
              :class="[
                'mb-1.5 flex items-center gap-1.5 px-1 text-[10px] leading-4 text-text-subtle',
                message.role === 'user' ? 'justify-end' : 'justify-center',
              ]"
            >
              <template v-if="message.role === 'user'">
              </template>
              <template v-else>
                <Bot :size="12" />
                <span>{{ getMessageAiName(message) }}</span>
              </template>
            </div>

            <div
              :class="[
                'break-words text-sm leading-6 select-text',
                message.role === 'assistant' ? 'mx-auto max-w-[760px] px-1 py-1 text-text-main' : '',
                message.role === 'assistant' ? '' : 'whitespace-pre-wrap',
                message.role === 'user'
                  ? 'rounded-2xl rounded-tr-md bg-accent px-3.5 py-3 text-white shadow-sm'
                  : message.role === 'system'
                    ? 'mx-auto max-w-[760px] px-1 py-2 text-center text-text-muted'
                    : '',
              ]"
            >
              <AiMarkdown
                v-if="message.role === 'assistant'"
                :content="message.text"
              />
              <template v-else-if="message.role === 'system' && message.actions?.some((action) => action.type === BUILD_INDEX_ACTION_TYPE)">
                <div class="mb-1.5 font-semibold text-text-main">
                  当前工作空间还没有索引
                </div>
                <div>
                  {{ message.text }}
                </div>
              </template>
              <template v-else>
                {{ message.text }}
              </template>

              <div
                v-if="message.role === 'assistant' && isMessageStreaming(message)"
                class="mt-2 inline-flex items-center gap-1.5 text-[11px] text-text-muted"
              >
                <Loader2 :size="12" class="animate-spin" />
                正在生成
              </div>

              <button
                v-if="message.role === 'assistant' && (message.timeline?.length || message.agentSummary)"
                type="button"
                class="mx-auto mt-3 flex h-7 items-center gap-1.5 rounded-md border border-border-soft bg-panel px-2.5 text-[10px] text-text-muted transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-text-main"
                @click="openProcessDrawer(message)"
              >
                <Workflow :size="12" />
                <span>{{ getMessageProcessState(message).statusLabel }}</span>
                <span v-if="getMessageProcessState(message).toolCallCount">· {{ getMessageProcessState(message).toolCallCount }} 次工具</span>
                <span v-if="getMessageProcessState(message).sourceCount">· {{ getMessageProcessState(message).sourceCount }} 个来源</span>
              </button>

              <div
                v-if="message.role === 'assistant' && !isMessageStreaming(message) && !(message.actions && message.actions.length)"
                class="mt-4 flex flex-wrap items-center justify-center gap-2 pt-1"
              >
                <button
                  class="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-text-muted"
                  type="button"
                  :disabled="!message.text.trim()"
                  @click="copyAssistantMessage(message)"
                >
                  <Copy :size="12" />
                  {{ copiedMessageId === message.id ? '已复制' : '复制' }}
                </button>
                <button
                  v-if="message.mode !== 'agent'"
                  class="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-text-muted transition-colors hover:bg-accent-soft hover:text-text-main disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-text-muted"
                  type="button"
                  :disabled="isAsking || isIndexing || isCheckingIndex || !hasWorkspace || !hasIndex"
                  @click="regenerateAssistantMessage(message)"
                >
                  <RotateCcw :size="12" />
                  重新生成
                </button>
              </div>
            </div>

            <div
              v-for="action in message.actions || []"
              :key="`${message.id}:${action.type}`"
              class="mx-auto mt-3 max-w-[760px] px-1 py-2 text-text-main"
              :class="message.role === 'system' ? 'text-center' : 'w-full'"
            >
              <div class="mb-3 flex items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-2">
                  <Loader2
                    v-if="isIndexing && action.type === BUILD_INDEX_ACTION_TYPE"
                    :size="14"
                    class="shrink-0 animate-spin text-text-muted"
                  />
                  <Sparkles v-else :size="14" class="shrink-0 text-accent" />
                  <span class="truncate text-xs font-medium text-text-main">
                    {{ action.title }}
                  </span>
                </div>
                <span v-if="message.role !== 'system'" class="shrink-0 text-[10px] text-text-subtle">本地 RAG</span>
              </div>
              <div class="text-xs leading-5 text-text-muted">
                {{ action.description }}
              </div>
              <button
                class="mt-3 inline-flex h-9 w-full items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors"
                :class="!isActionDisabled(action) && !(isIndexing && action.type === BUILD_INDEX_ACTION_TYPE)
                  ? 'bg-accent text-white hover:bg-accent-hover cursor-pointer'
                  : 'bg-panel-soft text-text-subtle cursor-not-allowed'"
                type="button"
                :disabled="isActionDisabled(action) || (isIndexing && action.type === BUILD_INDEX_ACTION_TYPE)"
                @click="runAction(action)"
              >
                {{ isIndexing && action.type === BUILD_INDEX_ACTION_TYPE ? '正在建立索引...' : action.buttonText }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <footer class="shrink-0 border-t border-border-soft bg-panel px-3 py-3">
      <form
        class="rounded-2xl border border-border-soft bg-panel-soft p-2.5 shadow-sm"
        @submit.prevent="askQuestion"
      >
        <textarea
          ref="composerRef"
          v-model="question"
          class="h-[58px] w-full resize-none bg-transparent text-sm leading-6 text-text-main outline-none placeholder:text-text-subtle disabled:text-text-muted select-text"
          :placeholder="inputPlaceholder"
          :disabled="!hasWorkspace || (modeNeedsIndex && (!hasIndex || isCheckingIndex || isIndexing)) || isGenerating"
          @keydown="handleComposerKeydown"
          @contextmenu="openComposerContextMenu"
        />
        <div class="flex items-center justify-between gap-2 pt-2">
          <div class="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <!-- <button
              class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border-soft bg-panel px-2.5 text-[11px] text-text-muted disabled:cursor-default disabled:opacity-80"
              type="button"
              disabled
            >
              <Paperclip :size="12" />
              附件
            </button>
            <button
              class="inline-flex h-7 shrink-0 items-center rounded-lg border border-border-soft bg-panel px-2.5 text-[11px] text-text-muted disabled:cursor-default disabled:opacity-80"
              type="button"
              disabled
            >
              @当前笔记
            </button>
            <button
              class="inline-flex h-7 shrink-0 items-center rounded-lg border border-border-soft bg-panel px-2.5 text-[11px] text-text-muted disabled:cursor-default disabled:opacity-80"
              type="button"
              disabled
            >
              /指令
            </button> -->
          </div>

          <button
            v-if="isGenerating"
            type="button"
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger transition-colors hover:bg-danger/20"
            aria-label="停止生成"
            @click="cancelCurrentGeneration"
          >
            <Square :size="13" fill="currentColor" />
          </button>
          <button
            v-else
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors"
            :class="canAsk
              ? 'bg-accent text-white hover:bg-accent-hover cursor-pointer shadow-sm'
              : 'bg-accent-soft text-text-muted cursor-not-allowed'"
            type="submit"
            :disabled="!canAsk"
            aria-label="发送"
          >
            <Send :size="14" />
          </button>
        </div>
      </form>
    </footer>

    <AgentTimelineDrawer
      :open="drawerOpen"
      :state="drawerState"
      @close="drawerOpen = false"
      @open-source="openTimelineSource"
    />

    <div
      v-if="aiContextMenu.visible"
      ref="contextMenuRef"
      class="fixed z-50 w-40 select-none rounded-lg border border-border-soft bg-panel py-1 text-sm text-text-main shadow-xl"
      :style="{ top: `${aiContextMenu.top}px`, left: `${aiContextMenu.left}px` }"
      @click.stop
    >
      <button
        v-if="aiContextMenu.selectedText"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent-soft"
        @click="copySelectedContextText"
      >
        <Copy :size="14" class="text-text-muted" />
        <span>复制</span>
      </button>
      <button
        v-if="aiContextMenu.source === 'composer'"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent-soft"
        @click="pasteIntoComposer"
      >
        <Clipboard :size="14" class="text-text-muted" />
        <span>粘贴</span>
      </button>
      <button
        v-if="aiContextMenu.source === 'messages' && aiContextMenu.selectedText"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent-soft"
        @click="addSelectionToComposer"
      >
        <MessageSquare :size="14" class="text-text-muted" />
        <span>加入对话框</span>
      </button>
      <button
        v-if="aiContextMenu.source === 'messages' && aiContextMenu.selectedText"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent-soft"
        @click="explainSelection"
      >
        <Sparkles :size="14" class="text-text-muted" />
        <span>AI解释</span>
      </button>
    </div>
  </div>
</template>
