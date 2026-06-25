import { defineStore } from 'pinia'
import {
  DEFAULT_ACTIVE_SIDEBAR_PANEL,
  resolveActiveSidebarPanel,
  toggleActiveSidebarPanel,
} from './sidebar-panels'
import {
  isEditableTextPath,
  isMissingDirectoryResult,
  isSameOrChildPath,
  isSupportedPath,
  normalizeDir,
  pathBase,
  pathDir,
  pathSep,
  remapByMoves,
  removePathsAndDescendants,
  resolveCurrentDir,
} from './workspace-utils'
import { executeRedoAction, executeUndoAction, type HistoryEffects } from './workspace-history-service'
import {
  buildWorkspaceMetaPayload,
} from './workspace-meta-utils'
import {
  createFileTab,
  createSystemTab,
  createTabsFromOpenedFiles,
  getFilePathsFromTabs,
  getFileTabId,
  getSystemTabId,
  getTabTitle,
  normalizeWorkspaceTabs,
  remapFileTabsByMoves,
  removeFileTabsByPaths,
} from './workspace-tab-utils'
import type { AiAssistantConversation, AiAssistantMessage, AiAssistantMessageAction, AiAssistantState, EditorSession, FileWorkspaceTab, FsEntry, OpenTextFileState, ResolvedThemeName, SettingsSectionId, SidebarPanelId, SystemPageId, SystemWorkspaceTab, ThemeName, UndoAction, Workspace, WorkspaceTab } from './workspace-types'
import { getAiAssistantConversationTitle, sortAiAssistantConversations } from './workspace-ai-utils'
export type { AiAssistantConversation, AiAssistantMessage, AiAssistantMessageAction, AiAssistantMessageRole, AiAssistantState, AiAssistantTimelineOutput, AiAssistantTimelineOutputType, AiAssistantTimelineStep, AiAssistantTimelineStepStatus, EditorSession, FileWorkspaceTab, FsEntry, OpenTextFileState, ResolvedThemeName, SettingsSectionId, SidebarPanelId, SidebarPanelState, SystemPageId, SystemWorkspaceTab, ThemeName, UndoAction, Workspace, WorkspaceMeta, WorkspaceTab } from './workspace-types'

let pendingTextInputResolve: ((value: string | null) => void) | null = null
let systemThemeCleanup: (() => void) | null = null

const createAiConversationId = () => `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const getAiConversationTitle = getAiAssistantConversationTitle

const createAiConversation = (messages?: AiAssistantMessage[], draft = ''): AiAssistantConversation => {
  const now = Date.now()
  const nextMessages = messages ?? [
    {
      id: 1,
      role: 'assistant',
      text: '你好，我是 Looma AI 助手。请先为当前工作空间建立索引，然后就可以向我提问。',
      createdAt: 1,
      aiName: 'Looma AI',
    },
  ]
  const timestamps = nextMessages.map((message) => message.createdAt).filter(Number.isFinite)
  const createdAt = timestamps.length > 0 ? Math.min(...timestamps) : now
  const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : now
  return {
    id: createAiConversationId(),
    title: getAiConversationTitle(nextMessages),
    createdAt,
    updatedAt,
    messages: nextMessages,
    draft,
  }
}

const createBlankAiConversation = (): AiAssistantConversation => {
  const now = Date.now()
  return {
    id: createAiConversationId(),
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
    draft: '',
  }
}

const createDefaultAiAssistantState = (): AiAssistantState => {
  const conversation = createAiConversation()
  return {
    conversations: [conversation],
    activeConversationId: conversation.id,
    temporaryDraft: '',
    isTemporaryConversation: false,
  }
}

const normalizeAiAssistantState = (state?: AiAssistantState | null): AiAssistantState => {
  const fallback = createDefaultAiAssistantState()
  if (!state) return fallback

  const normalizeActions = (actions: unknown): AiAssistantMessageAction[] | undefined => {
    if (!Array.isArray(actions)) return undefined
    const normalized = actions
      .filter((action): action is AiAssistantMessageAction =>
        Boolean(
          action
          && typeof action === 'object'
          && (action as any).type === 'build-index'
          && typeof (action as any).title === 'string'
          && typeof (action as any).description === 'string'
          && typeof (action as any).buttonText === 'string',
        ),
      )
      .map((action) => ({
        type: action.type,
        title: action.title,
        description: action.description,
        buttonText: action.buttonText,
        disabled: Boolean(action.disabled),
      }))
    return normalized.length > 0 ? normalized : undefined
  }

  const normalizeTimeline = (timeline: unknown): AiAssistantMessage['timeline'] | undefined => {
    if (!Array.isArray(timeline)) return undefined
    const allowedStatuses = new Set(['pending', 'active', 'completed', 'error'])
    const allowedOutputTypes = new Set(['text', 'source', 'metric', 'code', 'json', 'error'])
    const normalized = timeline
      .filter((step) => Boolean(
        step
        && typeof step === 'object'
        && typeof (step as any).id === 'string'
        && typeof (step as any).title === 'string'
        && allowedStatuses.has((step as any).status)
        && typeof (step as any).startedAt === 'number',
      ))
      .map((step: any) => ({
        id: step.id,
        title: step.title,
        description: typeof step.description === 'string' ? step.description : undefined,
        detail: typeof step.detail === 'string' ? step.detail : undefined,
        status: step.status,
        startedAt: step.startedAt,
        endedAt: typeof step.endedAt === 'number' ? step.endedAt : undefined,
        outputs: Array.isArray(step.outputs)
          ? step.outputs
            .filter((output: any) => Boolean(
              output
              && typeof output === 'object'
              && typeof output.id === 'string'
              && allowedOutputTypes.has(output.type),
            ))
            .map((output: any) => ({
              id: output.id,
              type: output.type,
              title: typeof output.title === 'string' ? output.title : undefined,
              content: typeof output.content === 'string' ? output.content : undefined,
              value: typeof output.value === 'string' || typeof output.value === 'number' ? output.value : undefined,
              unit: typeof output.unit === 'string' ? output.unit : undefined,
              path: typeof output.path === 'string' ? output.path : undefined,
              metadata: output.metadata && typeof output.metadata === 'object' ? output.metadata : undefined,
            }))
          : [],
      }))
    return normalized.length > 0 ? normalized : undefined
  }

  const normalizeMessages = (messages: unknown): AiAssistantMessage[] => (
    Array.isArray(messages)
      ? messages.filter((message): message is AiAssistantMessage =>
        Boolean(
          message
          && typeof message.id === 'number'
          && (message.role === 'assistant' || message.role === 'user' || message.role === 'system')
          && typeof message.text === 'string',
        ),
      ).map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        createdAt: typeof message.createdAt === 'number' ? message.createdAt : message.id,
        aiName: typeof (message as any).aiName === 'string' && (message as any).aiName.trim()
          ? (message as any).aiName.trim()
          : undefined,
        actions: normalizeActions(message.actions),
        timeline: normalizeTimeline(message.timeline),
      }))
      : []
  )

  const normalizeConversation = (conversation: any): AiAssistantConversation | null => {
    if (!conversation || typeof conversation !== 'object') return null
    const messages = normalizeMessages(conversation.messages)
    const now = Date.now()
    const id = typeof conversation.id === 'string' && conversation.id ? conversation.id : createAiConversationId()
    const title = typeof conversation.title === 'string' && conversation.title.trim()
      ? conversation.title.trim()
      : getAiConversationTitle(messages)
    const createdAt = typeof conversation.createdAt === 'number' ? conversation.createdAt : now
    const updatedAt = typeof conversation.updatedAt === 'number' ? conversation.updatedAt : createdAt
    return {
      id,
      title,
      createdAt,
      updatedAt,
      messages,
      draft: typeof conversation.draft === 'string' ? conversation.draft : '',
      archived: Boolean(conversation.archived),
      archivedAt: typeof conversation.archivedAt === 'number' ? conversation.archivedAt : undefined,
      pinned: Boolean(conversation.pinned),
      pinnedAt: typeof conversation.pinnedAt === 'number' ? conversation.pinnedAt : undefined,
      favorite: Boolean(conversation.favorite),
      favoriteCategory: typeof conversation.favoriteCategory === 'string' && conversation.favoriteCategory.trim()
        ? conversation.favoriteCategory.trim()
        : undefined,
      titleEdited: Boolean(conversation.titleEdited),
    }
  }

  const rawState = state as any
  const conversations = Array.isArray(rawState.conversations)
    ? rawState.conversations.map(normalizeConversation).filter((conversation): conversation is AiAssistantConversation => Boolean(conversation))
    : []

  if (conversations.length > 0) {
    const activeConversationId = conversations.some((conversation) => conversation.id === rawState.activeConversationId)
      ? rawState.activeConversationId
      : [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0].id
    return {
      conversations,
      activeConversationId,
      temporaryDraft: typeof rawState.temporaryDraft === 'string' ? rawState.temporaryDraft : '',
      isTemporaryConversation: false,
    }
  }

  if (Array.isArray(rawState.conversations)) {
    return {
      conversations: [],
      activeConversationId: null,
      temporaryDraft: typeof rawState.temporaryDraft === 'string' ? rawState.temporaryDraft : '',
      isTemporaryConversation: Boolean(rawState.isTemporaryConversation) || !rawState.activeConversationId,
    }
  }

  const legacyMessages = normalizeMessages(rawState.messages)
  if (legacyMessages.length > 0 || typeof rawState.draft === 'string') {
    const conversation = createAiConversation(legacyMessages.length > 0 ? legacyMessages : undefined, typeof rawState.draft === 'string' ? rawState.draft : '')
    return {
      conversations: [conversation],
      activeConversationId: conversation.id,
      temporaryDraft: '',
      isTemporaryConversation: false,
    }
  }

  return fallback
}

const isThemeName = (value: string | null): value is ThemeName =>
  value === 'light' || value === 'dark' || value === 'system'

const getStoredTheme = (): ThemeName => {
  if (typeof localStorage === 'undefined') return 'system'
  const stored = localStorage.getItem('theme')
  return isThemeName(stored) ? stored : 'system'
}

const resolveThemeName = (theme: ThemeName): ResolvedThemeName => {
  if (theme !== 'system') return theme
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    workspaces: [] as Workspace[],
    activeWorkspaceId: null as string | null,
    activeFilePath: '' as string,
    activeFileRelativePath: '' as string,
    activeFileContent: '' as string,
    activeFileLoadedContent: '' as string,
    activeFileIsSaving: false as boolean,
    activeFileSaveError: '' as string,
    openedTextFileContents: {} as Record<string, OpenTextFileState>,
    openedFiles: [] as string[],
    openedSystemPages: [] as SystemPageId[],
    tabs: [] as WorkspaceTab[],
    activeTabId: '' as string,
    activeSystemPage: null as SystemPageId | null,
    activeSettingsSection: 'appearance' as SettingsSectionId,
    activeSidebarPanel: DEFAULT_ACTIVE_SIDEBAR_PANEL as SidebarPanelId | null,
    aiAssistant: createDefaultAiAssistantState() as AiAssistantState,
    fileSessions: {} as Record<string, EditorSession>,
    selectedPaths: [] as string[],
    expandedDirs: [] as string[],
    noteOrder: {} as Record<string, string[]>,
    dirEntries: {} as Record<string, FsEntry[]>,
    isBusy: false as boolean,
    busyText: '' as string,
    isWorkspaceTransitioning: false as boolean,
    workspaceTransitionText: '' as string,
    lastError: '' as string,
    undoStack: [] as UndoAction[],
    redoStack: [] as UndoAction[],
    theme: getStoredTheme() as ThemeName,
    resolvedTheme: resolveThemeName(getStoredTheme()) as ResolvedThemeName,
    hasElectronWindowAPI: false as boolean,
    watchedWorkspaceId: null as string | null,
    fsUnsub: null as null | (() => void),
    inputDialogOpen: false as boolean,
    inputDialogTitle: '' as string,
    inputDialogPlaceholder: '' as string,
    inputDialogValue: '' as string,
    commandPaletteOpen: false as boolean,
    commandPaletteQuery: '' as string,
  }),
  getters: {
    activeWorkspace(state) {
      return state.workspaces.find((w) => w.id === state.activeWorkspaceId) || null
    },
    isSupportedActiveFile(state) {
      return isSupportedPath(state.activeFilePath)
    },
    hasUnsavedChanges(state) {
      if (!state.activeFilePath) return false
      if (!this.isSupportedActiveFile) return false
      if (!isEditableTextPath(state.activeFilePath)) return false // Media files don't have unsaved changes
      return state.activeFileContent !== state.activeFileLoadedContent
    },
    activeTab(state): WorkspaceTab | null {
      return state.tabs.find((tab) => tab.id === state.activeTabId) || null
    },
    activeFileTab(): FileWorkspaceTab | null {
      const tab = this.activeTab
      return tab?.kind === 'file' ? tab : null
    },
    activeSystemTab(): SystemWorkspaceTab | null {
      const tab = this.activeTab
      return tab?.kind === 'system' ? tab : null
    },
    keyOfDir: () => (dir: string) => normalizeDir(dir),
    activeDirEntries(state): FsEntry[] {
      if (!state.activeWorkspaceId) return []
      const currentDir = state.selectedPaths[0]
        ? (state.dirEntries[normalizeDir(state.selectedPaths[0])] ? state.selectedPaths[0] : pathDir(state.selectedPaths[0]))
        : ''
      const key = normalizeDir(currentDir)
      return state.dirEntries[key] || []
    },
    activeMarkdownFiles(): FsEntry[] {
      const entries = this.activeDirEntries
      return entries.filter((e) => !e.isDirectory && e.name.toLowerCase().endsWith('.md'))
    },
    activeExpandedSet(): Set<string> {
      return new Set(this.expandedDirs.map(normalizeDir))
    },
    activeAiAssistantConversation(state): AiAssistantConversation {
      if (state.aiAssistant.isTemporaryConversation || !state.aiAssistant.activeConversationId) {
        const now = Date.now()
        return {
          id: 'temporary',
          title: '新对话',
          createdAt: now,
          updatedAt: now,
          messages: [],
          draft: state.aiAssistant.temporaryDraft || '',
        }
      }
      return state.aiAssistant.conversations.find((conversation) => conversation.id === state.aiAssistant.activeConversationId)
        ?? state.aiAssistant.conversations[0]
        ?? createBlankAiConversation()
    },
    aiAssistantConversations(state): AiAssistantConversation[] {
      return sortAiAssistantConversations(state.aiAssistant.conversations)
    },
  },
  actions: {
    requestTextInput(title: string, defaultValue = '', placeholder = ''): Promise<string | null> {
      if (pendingTextInputResolve) {
        pendingTextInputResolve(null)
        pendingTextInputResolve = null
      }
      this.inputDialogTitle = title
      this.inputDialogPlaceholder = placeholder
      this.inputDialogValue = defaultValue
      this.inputDialogOpen = true
      return new Promise((resolve) => {
        pendingTextInputResolve = resolve
      })
    },

    submitTextInput() {
      const resolve = pendingTextInputResolve
      pendingTextInputResolve = null
      const value = this.inputDialogValue
      this.inputDialogOpen = false
      this.inputDialogTitle = ''
      this.inputDialogPlaceholder = ''
      this.inputDialogValue = ''
      resolve?.(value)
    },

    cancelTextInput() {
      const resolve = pendingTextInputResolve
      pendingTextInputResolve = null
      this.inputDialogOpen = false
      this.inputDialogTitle = ''
      this.inputDialogPlaceholder = ''
      this.inputDialogValue = ''
      resolve?.(null)
    },

    toggleTheme() {
      this.theme = this.theme === 'light' ? 'dark' : this.theme === 'dark' ? 'system' : 'light'
      if (typeof localStorage !== 'undefined') localStorage.setItem('theme', this.theme)
      this.applyTheme()
    },
    applyTheme() {
      const nextResolved = resolveThemeName(this.theme)
      this.resolvedTheme = nextResolved

      if (typeof document !== 'undefined') {
        document.documentElement.dataset.theme = nextResolved
        document.documentElement.classList.toggle('dark', nextResolved === 'dark')
      }

      if (systemThemeCleanup) {
        systemThemeCleanup()
        systemThemeCleanup = null
      }

      if (this.theme !== 'system') return
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return

      const media = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = () => {
        const resolved = resolveThemeName(this.theme)
        this.resolvedTheme = resolved
        if (typeof document === 'undefined') return
        document.documentElement.dataset.theme = resolved
        document.documentElement.classList.toggle('dark', resolved === 'dark')
      }

      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', onChange)
        systemThemeCleanup = () => media.removeEventListener('change', onChange)
      } else {
        media.addListener?.(onChange)
        systemThemeCleanup = () => media.removeListener?.(onChange)
      }
    },

    setBusy(isBusy: boolean, text = '') {
      this.isBusy = isBusy
      this.busyText = text
    },

    setWorkspaceTransition(isOn: boolean, text = '') {
      this.isWorkspaceTransitioning = isOn
      this.workspaceTransitionText = text
    },

    openCommandPalette(initialQuery = '') {
      this.commandPaletteQuery = initialQuery
      this.commandPaletteOpen = true
    },

    closeCommandPalette() {
      this.commandPaletteOpen = false
      this.commandPaletteQuery = ''
    },

    setError(message: string) {
      this.lastError = message
    },

    clearError() {
      this.lastError = ''
    },

    resetAiAssistantState() {
      this.aiAssistant = createDefaultAiAssistantState()
    },

    ensureActiveAiAssistantConversation() {
      let conversation = this.aiAssistant.conversations.find((item) => item.id === this.aiAssistant.activeConversationId)
      if (!conversation) {
        conversation = this.aiAssistant.conversations[0]
      }
      if (!conversation) {
        conversation = createBlankAiConversation()
        this.aiAssistant.conversations = [conversation]
      }
      this.aiAssistant.activeConversationId = conversation.id
      return conversation
    },

    saveAiAssistantState() {
      const id = this.activeWorkspaceId
      if (!id) return
      window.electronAPI.workspaceAi.set(id, JSON.parse(JSON.stringify(this.aiAssistant))).catch(() => {})
    },

    touchAiAssistantConversation(conversation: AiAssistantConversation) {
      conversation.updatedAt = Date.now()
      if (!conversation.titleEdited) {
        conversation.title = getAiConversationTitle(conversation.messages)
      }
    },

    startTemporaryAiAssistantConversation() {
      this.aiAssistant.activeConversationId = null
      this.aiAssistant.isTemporaryConversation = true
      this.aiAssistant.temporaryDraft = ''
    },

    materializeAiAssistantConversationIfNeeded() {
      if (!this.aiAssistant.isTemporaryConversation && this.aiAssistant.activeConversationId) {
        return this.ensureActiveAiAssistantConversation()
      }
      const conversation = createBlankAiConversation()
      conversation.draft = this.aiAssistant.temporaryDraft || ''
      this.aiAssistant.conversations.unshift(conversation)
      this.aiAssistant.activeConversationId = conversation.id
      this.aiAssistant.isTemporaryConversation = false
      this.aiAssistant.temporaryDraft = ''
      this.saveAiAssistantState()
      return conversation
    },

    appendAiAssistantMessage(role: AiAssistantMessage['role'], text: string, actions?: AiAssistantMessageAction[], meta?: { aiName?: string }) {
      const now = Date.now()
      const conversation = this.materializeAiAssistantConversationIfNeeded()
      const id = now + conversation.messages.length
      conversation.messages.push({
        id,
        role,
        text,
        createdAt: now,
        aiName: role === 'assistant' && meta?.aiName?.trim() ? meta.aiName.trim() : undefined,
        actions,
      })
      this.touchAiAssistantConversation(conversation)
      this.saveAiAssistantState()
      return id
    },

    updateAiAssistantMessageText(id: number, text: string, options?: { persist?: boolean }) {
      const conversation = this.ensureActiveAiAssistantConversation()
      const message = conversation.messages.find((item) => item.id === id)
      if (!message) return
      message.text = text
      this.touchAiAssistantConversation(conversation)
      if (options?.persist === false) return
      this.saveAiAssistantState()
    },

    updateAiAssistantMessageTimeline(id: number, timeline: AiAssistantMessage['timeline'], options?: { persist?: boolean }) {
      const conversation = this.ensureActiveAiAssistantConversation()
      const message = conversation.messages.find((item) => item.id === id)
      if (!message) return
      message.timeline = timeline
      this.touchAiAssistantConversation(conversation)
      if (options?.persist === false) return
      this.saveAiAssistantState()
    },

    updateAiAssistantMessageMeta(id: number, meta: { aiName?: string }, options?: { persist?: boolean }) {
      const conversation = this.ensureActiveAiAssistantConversation()
      const message = conversation.messages.find((item) => item.id === id)
      if (!message) return
      if (message.role === 'assistant') {
        message.aiName = meta.aiName?.trim() || undefined
      }
      this.touchAiAssistantConversation(conversation)
      if (options?.persist === false) return
      this.saveAiAssistantState()
    },

    backfillAiAssistantMessageNames(aiName: string) {
      const value = aiName.trim()
      if (!value) return

      let changed = false
      this.aiAssistant.conversations.forEach((conversation) => {
        conversation.messages.forEach((message) => {
          if (message.role !== 'assistant' || message.aiName?.trim()) return
          message.aiName = message.createdAt === 1 ? 'Looma AI' : value
          changed = true
        })
      })

      if (changed) {
        this.saveAiAssistantState()
      }
    },

    appendAiAssistantMessageText(id: number, text: string) {
      const conversation = this.ensureActiveAiAssistantConversation()
      const message = conversation.messages.find((item) => item.id === id)
      if (!message) return
      message.text += text
      this.touchAiAssistantConversation(conversation)
      this.saveAiAssistantState()
    },

    setAiAssistantActionDisabled(type: AiAssistantMessageAction['type'], disabled: boolean) {
      if (this.aiAssistant.isTemporaryConversation || !this.aiAssistant.activeConversationId) return
      let changed = false
      const conversation = this.ensureActiveAiAssistantConversation()
      conversation.messages = conversation.messages.map((message) => {
        if (!message.actions?.some((action) => action.type === type)) return message
        changed = true
        return {
          ...message,
          actions: message.actions.map((action) => action.type === type ? { ...action, disabled } : action),
        }
      })
      if (changed) {
        this.touchAiAssistantConversation(conversation)
        this.saveAiAssistantState()
      }
    },

    removeAiAssistantMessagesByText(texts: string[]) {
      if (this.aiAssistant.isTemporaryConversation || !this.aiAssistant.activeConversationId) return
      const blocked = new Set(texts)
      const conversation = this.ensureActiveAiAssistantConversation()
      const nextMessages = conversation.messages.filter((message) => !blocked.has(message.text))
      if (nextMessages.length === conversation.messages.length) return
      conversation.messages = nextMessages
      this.touchAiAssistantConversation(conversation)
      this.saveAiAssistantState()
    },

    setAiAssistantDraft(value: string) {
      if (this.aiAssistant.isTemporaryConversation || !this.aiAssistant.activeConversationId) {
        this.aiAssistant.isTemporaryConversation = true
        this.aiAssistant.activeConversationId = null
        this.aiAssistant.temporaryDraft = value
        return
      }
      const conversation = this.ensureActiveAiAssistantConversation()
      conversation.draft = value
      conversation.updatedAt = Date.now()
      this.saveAiAssistantState()
    },

    createAiAssistantConversation() {
      this.startTemporaryAiAssistantConversation()
      return 'temporary'
    },

    setActiveAiAssistantConversation(id: string) {
      if (this.aiAssistant.activeConversationId === id) return
      const conversation = this.aiAssistant.conversations.find((item) => item.id === id)
      if (!conversation) return
      this.aiAssistant.activeConversationId = id
      this.aiAssistant.isTemporaryConversation = false
      this.aiAssistant.temporaryDraft = ''
      this.saveAiAssistantState()
    },

    deleteAiAssistantConversation(id: string) {
      const nextConversations = this.aiAssistant.conversations.filter((conversation) => conversation.id !== id)
      if (nextConversations.length === this.aiAssistant.conversations.length) return

      if (nextConversations.length === 0) {
        this.aiAssistant.conversations = []
        this.aiAssistant.activeConversationId = null
        this.aiAssistant.isTemporaryConversation = true
        this.aiAssistant.temporaryDraft = ''
        this.saveAiAssistantState()
        return
      }

      this.aiAssistant.conversations = nextConversations
      if (this.aiAssistant.activeConversationId === id) {
        const nextActive = sortAiAssistantConversations(nextConversations.filter((conversation) => !conversation.archived))[0]
          ?? sortAiAssistantConversations(nextConversations)[0]
        this.aiAssistant.activeConversationId = nextActive?.id ?? null
        this.aiAssistant.isTemporaryConversation = !nextActive
      }
      this.saveAiAssistantState()
    },

    renameAiAssistantConversation(id: string, title: string) {
      const conversation = this.aiAssistant.conversations.find((item) => item.id === id)
      const value = title.trim()
      if (!conversation || !value) return
      conversation.title = value.length > 40 ? `${value.slice(0, 40)}...` : value
      conversation.titleEdited = true
      conversation.updatedAt = Date.now()
      this.saveAiAssistantState()
    },

    toggleArchiveAiAssistantConversation(id: string) {
      const conversation = this.aiAssistant.conversations.find((item) => item.id === id)
      if (!conversation) return
      conversation.archived = !conversation.archived
      conversation.archivedAt = conversation.archived ? Date.now() : undefined
      conversation.updatedAt = Date.now()
      this.saveAiAssistantState()
    },

    togglePinAiAssistantConversation(id: string) {
      const conversation = this.aiAssistant.conversations.find((item) => item.id === id)
      if (!conversation) return
      conversation.pinned = !conversation.pinned
      conversation.pinnedAt = conversation.pinned ? Date.now() : undefined
      this.saveAiAssistantState()
    },

    toggleFavoriteAiAssistantConversation(id: string, category = '默认收藏') {
      const conversation = this.aiAssistant.conversations.find((item) => item.id === id)
      if (!conversation) return
      conversation.favorite = !conversation.favorite
      conversation.favoriteCategory = conversation.favorite ? (category.trim() || '默认收藏') : undefined
      this.saveAiAssistantState()
    },

    setAiAssistantConversationFavoriteCategory(id: string, category: string) {
      const conversation = this.aiAssistant.conversations.find((item) => item.id === id)
      const value = category.trim()
      if (!conversation || !value) return
      conversation.favorite = true
      conversation.favoriteCategory = value
      this.saveAiAssistantState()
    },

    setActiveSidebarPanel(id: SidebarPanelId | null) {
      this.activeSidebarPanel = id
      this.saveWorkspaceMeta().catch(() => {})
    },

    toggleSidebarPanel(id: SidebarPanelId) {
      this.activeSidebarPanel = toggleActiveSidebarPanel(this.activeSidebarPanel, id)
      this.saveWorkspaceMeta().catch(() => {})
    },

    resetActiveFileState() {
      this.activeFilePath = ''
      this.activeFileRelativePath = ''
      this.activeFileContent = ''
      this.activeFileLoadedContent = ''
      this.activeFileIsSaving = false
      this.activeFileSaveError = ''
    },

    syncLegacyTabState() {
      this.openedFiles = getFilePathsFromTabs(this.tabs)
      this.openedSystemPages = this.tabs
        .filter((tab): tab is SystemWorkspaceTab => tab.kind === 'system')
        .map((tab) => tab.page)

      const active = this.tabs.find((tab) => tab.id === this.activeTabId) || null
      this.activeSystemPage = active?.kind === 'system' ? active.page : null
    },

    setTabs(nextTabs: WorkspaceTab[], activeTabId?: string) {
      const nextActiveTabId = activeTabId ?? this.activeTabId
      this.tabs = normalizeWorkspaceTabs(nextTabs)
      this.activeTabId = nextActiveTabId && this.tabs.some((tab) => tab.id === nextActiveTabId) ? nextActiveTabId : ''
      this.syncLegacyTabState()
    },

    openFileTab(relativePath: string) {
      const rel = normalizeDir(relativePath)
      if (!rel) {
        this.activeTabId = ''
        this.activeSystemPage = null
        this.resetActiveFileState()
        return
      }

      const id = getFileTabId(rel)
      if (!this.tabs.some((tab) => tab.id === id)) {
        this.tabs.push(createFileTab(rel))
      }
      this.activateTab(id)
    },

    openSystemTab(page: SystemPageId, options: { section?: SettingsSectionId } = {}) {
      const id = getSystemTabId(page)
      if (!this.tabs.some((tab) => tab.id === id)) {
        this.tabs.push(createSystemTab(page))
      }
      if (page === 'settings') {
        this.activeSettingsSection = options.section || this.activeSettingsSection
      }
      this.activateTab(id)
    },

    activateTab(tabId: string) {
      const tab = this.tabs.find((item) => item.id === tabId)
      if (!tab) return

      this.activeTabId = tab.id
      if (tab.kind === 'file') {
        this.activateFileTab(tab.relativePath)
      } else {
        this.activateSystemTab(tab.page)
      }
      this.syncLegacyTabState()
      this.saveWorkspaceMeta().catch(() => {})
    },

    openSettingsPage(section: SettingsSectionId = 'appearance') {
      this.openSystemTab('settings', { section })
    },

    openRagIndexPage() {
      this.openSystemTab('rag-index')
    },

    openAiHistoryPage() {
      this.openSystemTab('ai-history')
    },

    closeSystemPage(page: SystemPageId) {
      this.closeTab(getSystemTabId(page)).catch(() => {})
    },

    isFileDirty(relativePath: string) {
      const rel = normalizeDir(relativePath)
      const state = this.openedTextFileContents[rel]
      if (!state) return false
      return state.content !== state.loadedContent
    },

    isSystemTabDirty(_page: SystemPageId) {
      return false
    },

    isTabDirty(tabId: string) {
      const tab = this.tabs.find((item) => item.id === tabId)
      if (!tab) return false
      if (tab.kind === 'file') return this.isFileDirty(tab.relativePath)
      return this.isSystemTabDirty(tab.page)
    },

    async confirmCloseDirtyTab(tab: WorkspaceTab): Promise<'save' | 'discard' | 'cancel'> {
      const title = getTabTitle(tab)
      const result = await window.electronAPI.app.showMessageBox({
        type: 'warning',
        title: '内容尚未保存',
        message: `${title} 有未保存的更改，关闭前要保存吗？`,
        buttons: ['保存', '不保存', '取消'],
        defaultId: 0,
        cancelId: 2,
      })
      if (result.response === 0) return 'save'
      if (result.response === 1) return 'discard'
      return 'cancel'
    },

    async saveTab(tab: WorkspaceTab): Promise<boolean> {
      if (tab.kind === 'file') {
        const state = this.openedTextFileContents[tab.relativePath]
        const result = await this.saveActiveFileContent(state?.content, tab.relativePath)
        return result.success
      }
      return true
    },

    discardTabChanges(tab: WorkspaceTab) {
      if (tab.kind !== 'file') return
      const state = this.openedTextFileContents[tab.relativePath]
      if (!state) return
      this.openedTextFileContents[tab.relativePath] = {
        ...state,
        content: state.loadedContent,
        saveError: '',
      }
      this.mirrorActiveTextFileState(tab.relativePath)
    },

    cleanupTabState(tab: WorkspaceTab) {
      if (tab.kind === 'file') {
        this.removeOpenedTextFileStates([tab.relativePath])
      }
    },

    removeTab(tabId: string) {
      const idx = this.tabs.findIndex((tab) => tab.id === tabId)
      if (idx === -1) return

      const [removed] = this.tabs.splice(idx, 1)
      this.cleanupTabState(removed)

      if (this.activeTabId === tabId) {
        const nextTab = this.tabs[idx] || this.tabs[idx - 1]
        if (nextTab) {
          this.activeTabId = nextTab.id
          if (nextTab.kind === 'file') this.activateFileTab(nextTab.relativePath)
          else this.activateSystemTab(nextTab.page)
        } else {
          this.activeTabId = ''
          this.activeSystemPage = null
          this.resetActiveFileState()
        }
      }
      this.syncLegacyTabState()
    },

    async closeTab(tabId: string): Promise<boolean> {
      const tab = this.tabs.find((item) => item.id === tabId)
      if (!tab) return true

      if (this.isTabDirty(tabId)) {
        const decision = await this.confirmCloseDirtyTab(tab)
        if (decision === 'cancel') return false
        if (decision === 'save') {
          const saved = await this.saveTab(tab)
          if (!saved) return false
        } else {
          this.discardTabChanges(tab)
        }
      }

      this.removeTab(tabId)
      await this.saveWorkspaceMeta()
      return true
    },

    async closeTabsToRight(tabId: string) {
      const idx = this.tabs.findIndex((tab) => tab.id === tabId)
      if (idx === -1) return
      const toClose = this.tabs.slice(idx + 1)
      for (const tab of toClose) {
        const ok = await this.closeTab(tab.id)
        if (!ok) break
      }
    },

    async closeSavedTabs() {
      const toClose = this.tabs.filter((tab) => !this.isTabDirty(tab.id))
      for (const tab of toClose) {
        const ok = await this.closeTab(tab.id)
        if (!ok) break
      }
    },

    async closeAllTabs() {
      const toClose = [...this.tabs]
      for (const tab of toClose) {
        const ok = await this.closeTab(tab.id)
        if (!ok) break
      }
    },

    resolveAbsolutePath(relativePath: string) {
      const ws = this.activeWorkspace
      const rel = normalizeDir(relativePath)
      if (!ws || !rel) return ''
      const sep = pathSep(ws.path)
      const root = ws.path.endsWith(sep) ? ws.path.slice(0, -1) : ws.path
      return root + sep + rel.split('/').join(sep)
    },

    mirrorActiveTextFileState(relativePath: string) {
      const rel = normalizeDir(relativePath)
      if (rel !== this.activeFileRelativePath) return
      const state = this.openedTextFileContents[rel]
      if (!state) return
      this.activeFileContent = state.content
      this.activeFileLoadedContent = state.loadedContent
      this.activeFileIsSaving = state.isSaving
      this.activeFileSaveError = state.saveError
    },

    removeOpenedTextFileStates(relativePaths: string[]) {
      const targets = relativePaths.map(normalizeDir).filter(Boolean)
      for (const path of Object.keys(this.openedTextFileContents)) {
        const rel = normalizeDir(path)
        if (targets.some((target) => isSameOrChildPath(target, rel))) {
          delete this.openedTextFileContents[rel]
        }
      }
    },

    remapOpenedTextFileStates(items: { from: string; to: string }[]) {
      const nextStates: Record<string, OpenTextFileState> = {}
      for (const [relPath, state] of Object.entries(this.openedTextFileContents) as [string, OpenTextFileState][]) {
        nextStates[remapByMoves(relPath, items)] = state
      }
      this.openedTextFileContents = nextStates
    },

    getCurrentDir() {
      return resolveCurrentDir(this.selectedPaths, this.dirEntries)
    },

    async refreshDirs(workspaceId: string, dirs: string[]) {
      const uniqueDirs = Array.from(new Set(dirs.map(normalizeDir)))
      for (const dir of uniqueDirs) {
        await this.loadDir(workspaceId, dir)
      }
    },

    async ensureFileParentDirsExpanded(relativePath: string) {
      const ws = this.activeWorkspaceId
      if (!ws) return

      const parentDir = pathDir(relativePath)
      if (!parentDir) return

      const ancestors = parentDir
        .split('/')
        .map((_, index, parts) => parts.slice(0, index + 1).join('/'))

      const expanded = new Set(this.expandedDirs.map(normalizeDir))
      let changed = false

      for (const dir of ancestors) {
        if (!expanded.has(dir)) {
          expanded.add(dir)
          changed = true
        }
      }

      if (changed) {
        this.expandedDirs = Array.from(expanded)
      }

      for (const dir of ancestors) {
        await this.loadDir(ws, dir)
      }

      if (changed) {
        await this.saveWorkspaceMeta()
      }
    },

    async syncSelectionAfterRemoval(removedPaths: string[]) {
      const remaining = removePathsAndDescendants(this.selectedPaths, removedPaths)
      if (remaining.length !== this.selectedPaths.length) {
        this.selectedPaths = remaining
        await this.saveWorkspaceMeta()
      }
    },

    syncOpenedFilesAfterRemoval(removedPaths: string[]) {
      const prevIds = this.tabs.map((tab) => tab.id).join('\0')
      this.tabs = removeFileTabsByPaths(this.tabs, removedPaths)
      this.removeOpenedTextFileStates(removedPaths)
      if (this.activeFileRelativePath && removedPaths.some((path) => isSameOrChildPath(path, this.activeFileRelativePath))) {
        const nextTab = this.tabs[0]
        if (nextTab) {
          this.activeTabId = nextTab.id
          if (nextTab.kind === 'file') this.activateFileTab(nextTab.relativePath)
          else this.activateSystemTab(nextTab.page)
        } else {
          this.activeTabId = ''
          this.resetActiveFileState()
        }
      }
      this.syncLegacyTabState()
      return this.tabs.map((tab) => tab.id).join('\0') !== prevIds
    },

    syncOpenedFilesAfterMove(items: { from: string; to: string }[]) {
      const result = remapFileTabsByMoves(this.tabs, items)
      this.tabs = result.tabs
      const activeTab = this.activeTabId ? this.tabs.find((tab) => tab.id === this.activeTabId) : null
      if (!activeTab && this.activeFileRelativePath) {
        const remappedActive = remapByMoves(this.activeFileRelativePath, items)
        this.activeTabId = this.tabs.some((tab) => tab.id === getFileTabId(remappedActive)) ? getFileTabId(remappedActive) : this.activeTabId
      }
      this.remapOpenedTextFileStates(items)
      this.syncLegacyTabState()
      return result.changed
    },

    async applyHistoryEffects(effects: HistoryEffects, options: { reopenRestored?: boolean } = {}) {
      let shouldSaveMeta = false

      if (effects.removedPaths?.length) {
        const removedPaths = effects.removedPaths
        const isActiveFileRemoved = removedPaths.some((path) => isSameOrChildPath(path, this.activeFileRelativePath))
        if (isActiveFileRemoved) {
          this.resetActiveFileState()
        }

        if (this.syncOpenedFilesAfterRemoval(removedPaths)) {
          shouldSaveMeta = true
        }

        await this.syncSelectionAfterRemoval(removedPaths)
      }

      if (effects.movedItems?.length) {
        const movedItems = effects.movedItems
        const activeBeforeMove = this.activeFileRelativePath
        const activeAfterMove = activeBeforeMove ? remapByMoves(activeBeforeMove, movedItems) : activeBeforeMove

        if (this.syncOpenedFilesAfterMove(movedItems)) {
          shouldSaveMeta = true
        }

        const nextSelectedPaths = this.selectedPaths.map((path) => remapByMoves(path, movedItems))
        if (nextSelectedPaths.some((path, index) => path !== this.selectedPaths[index])) {
          this.selectedPaths = nextSelectedPaths
          shouldSaveMeta = true
        }

        const nextExpandedDirs = this.expandedDirs.map((path) => remapByMoves(path, movedItems))
        if (nextExpandedDirs.some((path, index) => path !== this.expandedDirs[index])) {
          this.expandedDirs = nextExpandedDirs
          shouldSaveMeta = true
        }

        if (activeAfterMove && activeAfterMove !== activeBeforeMove) {
          this.setActiveFileRelative(activeAfterMove)
          shouldSaveMeta = true
        }
      }

      if (options.reopenRestored && effects.restoredPaths?.length) {
        const restoredFile = effects.restoredPaths.find(isSupportedPath)
        if (restoredFile) {
          this.setActiveFileRelative(restoredFile)
          shouldSaveMeta = true
        }
      }

      if (shouldSaveMeta) {
        await this.saveWorkspaceMeta()
      }
    },

    async refreshHistoryDirs(workspaceId: string, effects?: HistoryEffects | null) {
      const currentDir = this.getCurrentDir()
      await this.refreshDirs(workspaceId, [currentDir, ...(effects?.affectedDirs || [])])
    },

    selectPath(path: string, multi: boolean = false, rightClick: boolean = false) {
      const p = normalizeDir(path)
      if (rightClick) {
        if (!this.selectedPaths.includes(p)) {
          this.selectedPaths = [p]
        }
      } else if (multi) {
        if (this.selectedPaths.includes(p)) {
          this.selectedPaths = this.selectedPaths.filter((x) => x !== p)
        } else {
          this.selectedPaths.push(p)
        }
      } else {
        this.selectedPaths = [p]
      }
      this.saveWorkspaceMeta().catch(console.error)
    },

    clearSelection() {
      this.selectedPaths = []
      this.saveWorkspaceMeta().catch(console.error)
    },

    async init() {
      this.applyTheme()
      if (!((window as any).electronAPI && (window as any).electronAPI.workspace)) {
        this.setError('请使用 Electron 启动应用')
        return
      }
      const urlParams = new URLSearchParams(window.location.search)
      const wsFromUrl = urlParams.get('workspaceId')
      
      const stateResult = await window.electronAPI.workspace.getState()
      if (!stateResult.success || !stateResult.data) {
        this.setError(stateResult.error || 'Failed to load workspaces')
        return
      }

      const listResult = await window.electronAPI.workspace.list()
      if (!listResult.success || !listResult.data) {
        this.setError(listResult.error || 'Failed to load workspaces')
        return
      }

      this.workspaces = listResult.data
      let nextActive = wsFromUrl || stateResult.data.activeId || this.workspaces[0]?.id || null
      while (nextActive) {
        const canOpen = await this.ensureWorkspaceCanOpen(nextActive)
        if (canOpen) break
        await this.refreshWorkspaces()
        nextActive = this.workspaces[0]?.id || null
      }
      this.activeWorkspaceId = nextActive

      if (!this.workspaces.length) {
        this.hasElectronWindowAPI = Boolean((window as any).electronAPI?.window)
        return
      }

      if (this.activeWorkspaceId) {
        await this.switchWorkspaceInternal(this.activeWorkspaceId)
      }

      this.hasElectronWindowAPI = Boolean((window as any).electronAPI?.window)
    },

    async switchWorkspaceFlow() {
      await this.openWorkspaceInNewWindowFlow()
    },

    async openWorkspaceInNewWindowFlow() {
      this.clearError()
      this.setBusy(true, '正在选择文件夹...')
      const dir = await window.electronAPI.workspace.selectDir()
      if (!dir) {
        this.setBusy(false)
        return
      }
      this.setBusy(true, '正在打开工作空间...')
      const defaultName = dir.split(/[\\/]/).pop() || 'Workspace'
      const result = await window.electronAPI.workspace.create(dir, defaultName)
      this.setBusy(false)
      if (!result.success || !result.data) {
        this.setError(result.error || 'Failed to create workspace')
        return
      }
      await this.refreshWorkspaces()
      await this.openWorkspaceInNewWindow(result.data.id)
    },

    async createWorkspaceFlow() {
      await this.openWorkspaceInNewWindowFlow()
    },

    async newWorkspaceFlow() {
      await this.newWorkspaceInNewWindowFlow()
    },

    async newWorkspaceInNewWindowFlow() {
      this.clearError()
      this.setBusy(true, '正在选择保存位置...')
      const parent = await window.electronAPI.workspace.selectDir()
      if (!parent) {
        this.setBusy(false)
        return
      }
      this.setBusy(false)
      const name = ((await this.requestTextInput('新建工作空间', 'Workspace', '输入工作空间名称')) ?? '').trim()
      if (!name) return
      const useTemplate = window.confirm('是否基于模板生成初始内容？\n\n确定：基于模板\n取消：空工作空间')
      this.setBusy(true, '正在创建工作空间...')
      const r = await window.electronAPI.workspace.new(parent, name, useTemplate ? 'basic' : 'empty')
      this.setBusy(false)
      if (!r.success || !r.data) {
        this.setError(r.error || 'Failed to create workspace')
        return
      }
      await this.refreshWorkspaces()
      await this.openWorkspaceInNewWindow(r.data.id)
    },

    async refreshWorkspaces() {
      const listResult = await window.electronAPI.workspace.list()
      if (!listResult.success || !listResult.data) {
        this.setError(listResult.error || 'Failed to load workspaces')
        return
      }
      this.workspaces = listResult.data
      if (this.activeWorkspaceId && !this.workspaces.some((w) => w.id === this.activeWorkspaceId)) {
        this.activeWorkspaceId = this.workspaces[0]?.id || null
      }
    },

    async removeMissingWorkspaceRecord(id: string, info?: { name?: string; path?: string }) {
      const fallback = this.workspaces.find((w) => w.id === id)
      const name = info?.name || fallback?.name || '该工作空间'
      const workspacePath = info?.path || fallback?.path || ''
      await (window as any).electronAPI.app.showMessageBox({
        type: 'warning',
        title: '工作空间已丢失',
        message: `${name} 已被移动或删除，已从最近打开记录中移除。`,
        detail: workspacePath,
        buttons: ['确定'],
        defaultId: 0,
        cancelId: 0,
      })

      const removeResult = await window.electronAPI.workspace.remove(id)
      if (!removeResult.success && removeResult.error !== 'Workspace not found') {
        this.setError(removeResult.error || 'Failed to remove workspace')
      }
      await this.refreshWorkspaces()
    },

    async ensureWorkspaceCanOpen(id: string) {
      const existsResult = await window.electronAPI.workspace.checkExists(id)
      if (!existsResult.success) {
        this.setError(existsResult.error || 'Failed to check workspace')
        return false
      }
      if (!existsResult.data) return false
      if (existsResult.data.exists) return true
      await this.removeMissingWorkspaceRecord(id, existsResult.data)
      return false
    },

    async clearActiveWorkspace() {
      const prev = this.watchedWorkspaceId
      if (prev) {
        await window.electronAPI.fs.watchStop(prev)
      }
      this.activeWorkspaceId = null
      this.resetActiveFileState()
      this.openedSystemPages = []
      this.tabs = []
      this.activeTabId = ''
      this.activeSystemPage = null
      this.watchedWorkspaceId = null
      this.openedFiles = []
      this.openedTextFileContents = {}
      this.activeSidebarPanel = DEFAULT_ACTIVE_SIDEBAR_PANEL
      this.resetAiAssistantState()
      this.selectedPaths = []
      this.expandedDirs = []
      this.noteOrder = {}
      this.dirEntries = {}
      this.undoStack = []
      this.redoStack = []

      await window.electronAPI.workspace.setActive(null)
    },

    async openWorkspaceInNewWindow(id: string) {
      if (!id) return
      const canOpen = await this.ensureWorkspaceCanOpen(id)
      if (!canOpen) return
      await (window as any).electronAPI?.window?.openWorkspace?.(id)
    },

    async switchWorkspace(id: string) {
      if (!id) return
      if (this.isWorkspaceTransitioning) return

      const canOpen = await this.ensureWorkspaceCanOpen(id)
      if (!canOpen) return

      this.setWorkspaceTransition(true, '正在保存...')
      const okToLeave = await this.ensureSavedBeforeWorkspaceChange()
      if (!okToLeave) {
        this.setWorkspaceTransition(false, '')
        return
      }

      try {
        await this.saveWorkspaceMeta()
      } catch {}

      this.setWorkspaceTransition(true, '正在切换工作空间...')
      const prev = this.watchedWorkspaceId
      if (prev && prev !== id) {
        await window.electronAPI.fs.watchStop(prev)
      }
      this.dirEntries = {}
      this.undoStack = []
      this.redoStack = []
      this.activeWorkspaceId = null // clear ID during transition to block watchers/snapshots from saving incorrectly
      await this.switchWorkspaceInternal(id)
      this.setWorkspaceTransition(false, '')
    },

    async switchWorkspaceInternal(id: string) {
      this.activeWorkspaceId = id
      this.resetActiveFileState()
      const activeResult = await window.electronAPI.workspace.setActive(id)
      if (!activeResult.success) {
        this.activeWorkspaceId = null
        this.setError(activeResult.error || 'Failed to set active workspace')
        return
      }
      await this.loadWorkspaceMeta(id)

      await window.electronAPI.fs.watchStart(id)
      this.watchedWorkspaceId = id
      this.attachFsEvents()

      await this.loadDir(id, '')
      this.loadRestoredDirsInBackground(id).catch(() => {})
    },

    async loadWorkspaceMeta(id: string) {
      const metaResult = await window.electronAPI.workspaceMeta.get(id)
      if (!metaResult.success || !metaResult.data) {
        this.expandedDirs = []
        this.selectedPaths = []
        this.noteOrder = {}
        this.openedFiles = []
        this.openedSystemPages = []
        this.tabs = []
        this.activeTabId = ''
        this.activeSystemPage = null
        this.openedTextFileContents = {}
        this.activeSidebarPanel = DEFAULT_ACTIVE_SIDEBAR_PANEL
        this.resetAiAssistantState()
        await this.loadAiAssistantState(id)
        this.fileSessions = {}
        return
      }
      this.expandedDirs = Array.isArray(metaResult.data.expandedDirs) ? metaResult.data.expandedDirs : []
      this.selectedPaths = Array.isArray(metaResult.data.selectedPaths) ? metaResult.data.selectedPaths.map(normalizeDir) : []
      this.noteOrder = metaResult.data.noteOrder || {}
      const legacyOpenedFiles = Array.isArray(metaResult.data.openedFiles) ? metaResult.data.openedFiles.map(normalizeDir) : []
      const restoredTabs = normalizeWorkspaceTabs(metaResult.data.tabs)
      this.tabs = restoredTabs.length > 0 ? restoredTabs : createTabsFromOpenedFiles(legacyOpenedFiles)

      const activeTabIdFromMeta = typeof metaResult.data.activeTabId === 'string' ? metaResult.data.activeTabId : ''
      const activeFileTabId = metaResult.data.activeFile ? getFileTabId(metaResult.data.activeFile) : ''
      this.activeTabId = this.tabs.some((tab) => tab.id === activeTabIdFromMeta)
        ? activeTabIdFromMeta
        : this.tabs.some((tab) => tab.id === activeFileTabId)
          ? activeFileTabId
          : this.tabs[this.tabs.length - 1]?.id || ''
      this.syncLegacyTabState()

      this.fileSessions = metaResult.data.fileSessions || {}
      await this.loadAiAssistantState(id)
      this.openedTextFileContents = {}
      this.activeSidebarPanel = resolveActiveSidebarPanel(
        metaResult.data.activeSidebarPanel,
        metaResult.data.sidebarPanels,
      )
      
      // Restore active tab
      if (this.activeTabId) {
        this.activateTab(this.activeTabId)
      }
    },

    async loadAiAssistantState(id: string) {
      const aiResult = await window.electronAPI.workspaceAi.get(id)
      if (!aiResult.success || !aiResult.data) {
        this.resetAiAssistantState()
        return
      }
      this.aiAssistant = normalizeAiAssistantState(aiResult.data)
    },

    async saveWorkspaceMeta() {
      // Trigger snapshot save synchronously before writing to disk
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('request-save-snapshot'))
      }

      const id = this.activeWorkspaceId
      if (!id) return

      const { cleanedSessions, meta } = buildWorkspaceMetaPayload({
        expandedDirs: this.expandedDirs,
        selectedPaths: this.selectedPaths,
        noteOrder: this.noteOrder,
        openedFiles: this.openedFiles,
        tabs: this.tabs,
        activeTabId: this.activeTabId,
        activeSidebarPanel: this.activeSidebarPanel,
        activeFileRelativePath: this.activeFileRelativePath,
        fileSessions: this.fileSessions,
      })
      this.fileSessions = cleanedSessions
      await window.electronAPI.workspaceMeta.set(id, meta)
    },

    saveFileSession(relPath: string, session: Partial<EditorSession>, skipSaveMeta = false) {
      if (!relPath) return
      // Prevent saving session if there is no active workspace yet or we are transitioning
      if (!this.activeWorkspaceId || this.isWorkspaceTransitioning) return

      const existing = this.fileSessions[relPath] || { updatedAt: Date.now() }
      this.fileSessions[relPath] = {
        ...existing,
        ...session,
        updatedAt: Date.now()
      }
      // Trigger a debounced or unawaited save to ensure it is persisted immediately
      if (!skipSaveMeta) {
        this.saveWorkspaceMeta().catch(() => {})
      }
    },

    async reorderWorkspaces(nextOrder: string[]) {
      this.workspaces = nextOrder.map((id) => this.workspaces.find((w) => w.id === id)).filter(Boolean) as Workspace[]
      await window.electronAPI.workspace.reorder(nextOrder)
    },

    async renameWorkspace(id: string) {
      const ws = this.workspaces.find((w) => w.id === id)
      if (!ws) return
      const name = ((await this.requestTextInput('重命名工作空间', ws.name)) ?? '').trim()
      if (!name) return
      const r = await window.electronAPI.workspace.rename(id, name)
      if (!r.success) this.setError(r.error || 'Failed to rename workspace')
      await this.refreshWorkspaces()
    },

    async removeWorkspace(id: string, skipConfirm = false) {
      const ws = this.workspaces.find((w) => w.id === id)
      if (!ws) return
      if (!skipConfirm) {
        const ok = window.confirm(`从列表移除工作空间：${ws.name}？`)
        if (!ok) return
      }
      const r = await window.electronAPI.workspace.remove(id)
      if (!r.success) this.setError(r.error || 'Failed to remove workspace')
      await this.refreshWorkspaces()
      if (this.activeWorkspaceId) await this.switchWorkspace(this.activeWorkspaceId)
    },

    async loadDir(workspaceId: string, dirRelativePath: string) {
      const dir = normalizeDir(dirRelativePath)
      const r = await window.electronAPI.fs.listDir(workspaceId, dir || '.')
      if (!r.success || !r.data) {
        if (isMissingDirectoryResult(r)) {
          if (dir === '') return
          this.expandedDirs = this.expandedDirs.filter((p) => p !== dir)
          this.selectedPaths = this.selectedPaths.filter((p) => p !== dir && !p.startsWith(dir + '/'))
          if (this.activeFileRelativePath && this.activeFileRelativePath.startsWith(dir + '/')) {
            this.resetActiveFileState()
          }
          delete this.dirEntries[dir]
          await this.saveWorkspaceMeta()
        } else {
          this.setError(r.error || 'Failed to list directory')
        }
        return
      }
      this.dirEntries[dir] = r.data
      window.electronAPI.fs.watchAdd?.(workspaceId, [dir || '.']).catch(() => {})
    },

    async loadRestoredDirsInBackground(workspaceId: string) {
      const wsId = workspaceId
      const dirs = new Set<string>()

      for (const p of this.selectedPaths) {
        const d = normalizeDir(pathDir(p))
        if (d) dirs.add(d)
      }

      for (const p of this.expandedDirs) {
        const d = normalizeDir(p)
        if (d) dirs.add(d)
      }

      const sorted = Array.from(dirs).sort((a, b) => a.split('/').length - b.split('/').length)

      for (const d of sorted) {
        if (this.activeWorkspaceId !== wsId) return
        const key = d
        if (this.dirEntries[key]) continue
        await this.loadDir(wsId, d)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    },

    async selectDir(dirRelativePath: string) {
      const ws = this.activeWorkspaceId
      if (!ws) return
      this.selectPath(dirRelativePath, false, false)
      await this.loadDir(ws, normalizeDir(dirRelativePath))
      await this.saveWorkspaceMeta()
    },

    async toggleDirExpanded(dirRelativePath: string) {
      const dir = normalizeDir(dirRelativePath)
      const set = new Set(this.expandedDirs.map(normalizeDir))
      if (set.has(dir)) set.delete(dir)
      else set.add(dir)
      this.expandedDirs = Array.from(set)
      const ws = this.activeWorkspaceId
      if (ws) await this.loadDir(ws, dir)
      await this.saveWorkspaceMeta()
    },

    setActiveFileRelative(relativePath: string) {
      this.openFileTab(relativePath)
    },

    activateFileTab(relativePath: string) {
      const rel = normalizeDir(relativePath)
      if (!rel) {
        this.resetActiveFileState()
        return
      }

      const ws = this.activeWorkspace
      if (!ws) return
      this.activeSystemPage = null
      this.activeFileRelativePath = rel
      this.activeFilePath = this.resolveAbsolutePath(rel)

      const existing = this.openedTextFileContents[rel]
      if (existing) {
        this.mirrorActiveTextFileState(rel)
      } else {
        this.activeFileContent = ''
        this.activeFileLoadedContent = ''
        this.activeFileIsSaving = false
        this.activeFileSaveError = ''
      }
      this.loadTextFileContent(rel).catch(() => {})
    },

    activateSystemTab(page: SystemPageId) {
      this.activeSystemPage = page
    },

    setActiveFileContent(content: string, relativePath?: string) {
      const rel = normalizeDir(relativePath ?? this.activeFileRelativePath)
      if (!rel) return
      const existing = this.openedTextFileContents[rel]
      this.openedTextFileContents[rel] = {
        content,
        loadedContent: existing?.loadedContent ?? '',
        isSaving: existing?.isSaving ?? false,
        saveError: existing?.saveError ?? '',
      }
      if (rel === this.activeFileRelativePath) {
        this.activeFileContent = content
      }
    },

    async loadActiveFileContent() {
      await this.loadTextFileContent(this.activeFileRelativePath)
    },

    async loadTextFileContent(relativePath: string) {
      const rel = normalizeDir(relativePath)
      const absPath = this.resolveAbsolutePath(rel)
      const existing = this.openedTextFileContents[rel]
      if (existing && existing.content !== existing.loadedContent) {
        this.mirrorActiveTextFileState(rel)
        return
      }
      if (!absPath || !isSupportedPath(absPath) || !isEditableTextPath(absPath)) {
        if (rel === this.activeFileRelativePath) {
          this.activeFileContent = ''
          this.activeFileLoadedContent = ''
          this.activeFileSaveError = ''
        }
        return
      }

      const r = await window.electronAPI.file.readMarkdown(absPath)
      if (!r.success || r.data === undefined) {
        this.setError(r.error || 'Failed to load file')
        if (rel === this.activeFileRelativePath) {
          this.activeFileContent = ''
          this.activeFileLoadedContent = ''
        }
        return
      }
      this.openedTextFileContents[rel] = {
        content: r.data,
        loadedContent: r.data,
        isSaving: false,
        saveError: '',
      }
      this.mirrorActiveTextFileState(rel)
    },

    async saveActiveFileContent(content?: string, relativePath?: string) {
      const rel = normalizeDir(relativePath ?? this.activeFileRelativePath)
      const absPath = this.resolveAbsolutePath(rel)
      if (!absPath) return { success: true as const }
      if (!isSupportedPath(absPath)) return { success: true as const }
      if (!isEditableTextPath(absPath)) return { success: true as const } // Don't save media files
      
      const currentState = this.openedTextFileContents[rel]
      const next = content ?? currentState?.content ?? (rel === this.activeFileRelativePath ? this.activeFileContent : '')
      this.openedTextFileContents[rel] = {
        content: next,
        loadedContent: currentState?.loadedContent ?? '',
        isSaving: true,
        saveError: '',
      }
      this.mirrorActiveTextFileState(rel)
      const r = await window.electronAPI.file.writeMarkdown(absPath, next)
      const latestState = this.openedTextFileContents[rel]
      if (!r.success) {
        this.openedTextFileContents[rel] = {
          content: latestState?.content ?? next,
          loadedContent: latestState?.loadedContent ?? '',
          isSaving: false,
          saveError: r.error || 'Failed to save file',
        }
        this.mirrorActiveTextFileState(rel)
        return r
      }
      this.openedTextFileContents[rel] = {
        content: next,
        loadedContent: next,
        isSaving: false,
        saveError: '',
      }
      this.mirrorActiveTextFileState(rel)
      return r
    },

    async ensureSavedBeforeWorkspaceChange(): Promise<boolean> {
      if (!this.hasUnsavedChanges) return true
      const r = await this.saveActiveFileContent()
      if (r.success) return true
      const ok = window.confirm(
        `自动保存失败：${r.error || '未知错误'}\n\n是否强制切换并丢弃未保存变更？\n\n确定：强制切换\n取消：取消切换`,
      )
      return ok
    },

    async createMarkdown(title?: string, dirRelativePath?: string) {
      const ws = this.activeWorkspaceId
      if (!ws) return
      let name = ((title ?? (await this.requestTextInput('新建 Markdown 文件', 'Untitled'))) ?? '').trim()
      if (!name) return
      if (!name.includes('.')) {
        name += '.md'
      }
      const currentDir = this.getCurrentDir()
      const targetDir = normalizeDir(dirRelativePath ?? currentDir) || '.'
      this.setBusy(true, '创建中...')
      const r = await window.electronAPI.fs.createFile(ws, targetDir, name)
      this.setBusy(false)
      if (!r.success || !r.data) {
        this.setError(r.error || 'Failed to create file')
        return
      }
      this.undoStack.unshift({ type: 'create', relativePath: r.data })
      this.redoStack = []
      await this.loadDir(ws, normalizeDir(pathDir(r.data)))
      await this.loadDir(ws, currentDir)
      this.setActiveFileRelative(r.data)
    },

    async createFolder(name?: string, dirRelativePath?: string) {
      const ws = this.activeWorkspaceId
      if (!ws) return
      const folderName = ((name ?? (await this.requestTextInput('新建文件夹', 'New Folder'))) ?? '').trim()
      if (!folderName) return
      const currentDir = this.getCurrentDir()
      const targetDir = normalizeDir(dirRelativePath ?? currentDir) || '.'
      this.setBusy(true, '创建中...')
      const r = await window.electronAPI.fs.createFolder(ws, targetDir, folderName)
      this.setBusy(false)
      if (!r.success || !r.data) {
        this.setError(r.error || 'Failed to create folder')
        return
      }
      this.undoStack.unshift({ type: 'create', relativePath: r.data })
      this.redoStack = []
      await this.loadDir(ws, normalizeDir(pathDir(r.data)))
      await this.loadDir(ws, currentDir)
    },

    async deleteEntries(relativePaths: string[]) {
      const ws = this.activeWorkspaceId
      if (!ws || relativePaths.length === 0) return
      this.setBusy(true, '删除中...')
      
      const items: { trashRelativePath: string; restoreTo: string }[] = []
      for (const p of relativePaths) {
        const r = await window.electronAPI.fs.delete(ws, normalizeDir(p))
        if (r.success && r.data) {
          items.push({ trashRelativePath: r.data.trashRelativePath, restoreTo: normalizeDir(p) })
        } else {
          this.setError(r.error || '删除失败')
        }
      }
      this.setBusy(false)
      
      if (items.length > 0) {
        this.undoStack.unshift({
          type: 'delete',
          items
        })
        this.redoStack = []
        await this.refreshDirs(ws, [this.getCurrentDir()])
        
        const deletedPaths = items.map(i => i.restoreTo)
        const isActiveFileDeleted = deletedPaths.some(dp => 
          isSameOrChildPath(dp, this.activeFileRelativePath)
        )
        if (isActiveFileDeleted) {
          this.resetActiveFileState()
        }
        
        if (this.syncOpenedFilesAfterRemoval(deletedPaths)) {
          this.saveWorkspaceMeta().catch(() => {})
        }

        await this.syncSelectionAfterRemoval(deletedPaths)
      }
    },

    async moveEntries(fromRelativePaths: string[], targetDirRelativePath: string) {
      const ws = this.activeWorkspaceId
      if (!ws || fromRelativePaths.length === 0) return
      
      this.setBusy(true, '移动中...')
      
      const items: { from: string; to: string }[] = []
      for (const fromRelative of fromRelativePaths) {
        const name = fromRelative.split('/').pop() || fromRelative
        const toRelative = (targetDirRelativePath ? targetDirRelativePath + '/' + name : name).replace(/\/{2,}/g, '/')
        
        if (normalizeDir(fromRelative) === normalizeDir(toRelative)) continue
        
        const r = await window.electronAPI.fs.move(ws, normalizeDir(fromRelative), normalizeDir(toRelative))
        if (r.success) {
          items.push({ from: normalizeDir(fromRelative), to: normalizeDir(toRelative) })
        } else {
          this.setError(r.error || '移动失败')
        }
      }
      this.setBusy(false)
      
      if (items.length > 0) {
        this.undoStack.unshift({ type: 'move', items })
        this.redoStack = []
        
        await this.refreshDirs(ws, [this.getCurrentDir(), targetDirRelativePath])
        
        const remainingPaths = this.selectedPaths.filter(p => !items.some(i => i.from === p))
        if (remainingPaths.length !== this.selectedPaths.length) {
          this.selectedPaths = remainingPaths
          this.saveWorkspaceMeta().catch(console.error)
        }
        
        const wasActiveFile = items.some((item) => this.activeFileRelativePath === item.from)
        const activeAfterMove = wasActiveFile ? remapByMoves(this.activeFileRelativePath, items) : ''
        if (this.syncOpenedFilesAfterMove(items)) {
          if (activeAfterMove) this.activateFileTab(activeAfterMove)
          this.saveWorkspaceMeta().catch(() => {})
        }
      }
    },

    async renameEntry(relativePath: string, nextBaseValue?: string) {
      const ws = this.activeWorkspaceId
      if (!ws) return
      const from = normalizeDir(relativePath)
      const base = pathBase(from)
      const nextBase = ((nextBaseValue ?? (await this.requestTextInput('重命名', base))) ?? base).trim()
      if (!nextBase || nextBase === base) return
      const dir = pathDir(from)
      const to = dir ? dir + '/' + nextBase : nextBase
      const r = await window.electronAPI.fs.rename(ws, from, nextBase)
      if (!r.success) {
        this.setError(r.error || '重命名失败')
        return
      }
      
      if (this.syncOpenedFilesAfterMove([{ from, to }])) {
        if (this.activeFileRelativePath === from) this.activateFileTab(to)
        this.saveWorkspaceMeta().catch(() => {})
      }

      this.undoStack.unshift({ type: 'move', items: [{ from, to }] })
      this.redoStack = []
    },

    async undo() {
      const action = this.undoStack.shift()
      if (!action) return
      const ws = this.activeWorkspaceId
      if (!ws) return
      const historyResult = await executeUndoAction(action, {
        workspaceId: ws,
        api: window.electronAPI,
        setBusy: (isBusy, text) => this.setBusy(isBusy, text),
      })
      if (!historyResult) return
      this.redoStack.unshift(historyResult.action)
      await this.applyHistoryEffects(historyResult.effects)
      if (this.activeWorkspaceId) await this.refreshHistoryDirs(this.activeWorkspaceId, historyResult.effects)
    },

    async redo() {
      const action = this.redoStack.shift()
      if (!action) return
      const ws = this.activeWorkspaceId
      if (!ws) return
      const historyResult = await executeRedoAction(action, {
        workspaceId: ws,
        api: window.electronAPI,
        setBusy: (isBusy, text) => this.setBusy(isBusy, text),
      })
      if (!historyResult) return
      this.undoStack.unshift(historyResult.action)
      await this.applyHistoryEffects(historyResult.effects, { reopenRestored: action.type === 'restore' })
      if (this.activeWorkspaceId) await this.refreshHistoryDirs(this.activeWorkspaceId, historyResult.effects)
    },

    attachFsEvents() {
      if (this.fsUnsub) return
      this.fsUnsub = window.electronAPI.fs.onEvent((payload) => {
        if (payload.workspaceId !== this.activeWorkspaceId) return
        const affected = normalizeDir(pathDir(payload.relativePath))
        const key = affected
        if (this.dirEntries[key]) this.loadDir(payload.workspaceId, affected)
      })
    },

    async showItemInFolder(relativePath: string) {
      const ws = this.activeWorkspaceId
      if (!ws) return
      const r = await window.electronAPI.fs.showItemInFolder(ws, normalizeDir(relativePath))
      if (!r.success) {
        this.setError(r.error || '无法在资源管理器中显示文件')
        return
      }
    },

    async isFile(relativePath: string) {
      const ws = this.activeWorkspaceId
      if (!ws) return null
      const r = await window.electronAPI.fs.isFile(ws, normalizeDir(relativePath))
      if (!r.success) {
        this.setError(r.error || '无法判断文件类型')
        return null
      }
      return r.data
    },
  },
})
