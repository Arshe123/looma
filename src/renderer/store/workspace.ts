import { defineStore } from 'pinia'
import {
  DEFAULT_ACTIVE_SIDEBAR_PANEL,
  resolveActiveSidebarPanel,
  toggleActiveSidebarPanel,
} from './sidebar-panels'
import {
  isEditableTextPath,
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
import type { EditorSession, FsEntry, OpenTextFileState, ResolvedThemeName, SidebarPanelId, ThemeName, UndoAction, Workspace } from './workspace-types'
export type { EditorSession, FsEntry, OpenTextFileState, ResolvedThemeName, SidebarPanelId, SidebarPanelState, ThemeName, UndoAction, Workspace, WorkspaceMeta } from './workspace-types'

let pendingTextInputResolve: ((value: string | null) => void) | null = null
let systemThemeCleanup: (() => void) | null = null

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
    activeSidebarPanel: DEFAULT_ACTIVE_SIDEBAR_PANEL as SidebarPanelId | null,
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
      for (const path of relativePaths) {
        const rel = normalizeDir(path)
        delete this.openedTextFileContents[rel]
      }
    },

    remapOpenedTextFileStates(items: { from: string; to: string }[]) {
      const nextStates: Record<string, OpenTextFileState> = {}
      for (const [relPath, state] of Object.entries(this.openedTextFileContents)) {
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
      const prevLen = this.openedFiles.length
      this.openedFiles = removePathsAndDescendants(this.openedFiles, removedPaths)
      this.removeOpenedTextFileStates(removedPaths)
      return this.openedFiles.length !== prevLen
    },

    syncOpenedFilesAfterMove(items: { from: string; to: string }[]) {
      let changed = false
      this.openedFiles = this.openedFiles.map((of) => {
        const next = remapByMoves(of, items)
        if (next !== of) changed = true
        return next
      })
      this.remapOpenedTextFileStates(items)
      return changed
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
      const nextActive = wsFromUrl || stateResult.data.activeId || this.workspaces[0]?.id || null
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

    async clearActiveWorkspace() {
      const prev = this.watchedWorkspaceId
      if (prev) {
        await window.electronAPI.fs.watchStop(prev)
      }
      this.activeWorkspaceId = null
      this.resetActiveFileState()
      this.watchedWorkspaceId = null
      this.openedFiles = []
      this.openedTextFileContents = {}
      this.activeSidebarPanel = DEFAULT_ACTIVE_SIDEBAR_PANEL
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
      await (window as any).electronAPI?.window?.openWorkspace?.(id)
    },

    async switchWorkspace(id: string) {
      if (!id) return
      if (this.isWorkspaceTransitioning) return

      const existsResult = await (window as any).electronAPI.workspace.checkExists(id)
      if (existsResult.success && existsResult.data) {
        if (!existsResult.data.exists) {
          const res = await (window as any).electronAPI.app.showMessageBox({
            type: 'warning',
            title: '工作空间已丢失',
            message: '工作空间已被删除或转移，是否移除记录或重建？',
            buttons: ['取消', '移除', '重建'],
            defaultId: 2,
            cancelId: 0
          })
          if (res.response === 1) {
            await this.removeWorkspace(id, true)
            return
          } else if (res.response === 2) {
            this.setBusy(true, '正在重建工作空间...')
            const createRes = await (window as any).electronAPI.workspace.recreate(id)
            this.setBusy(false)
            if (!createRes.success) {
              this.setError(createRes.error || '重建失败')
              return
            }
          } else {
            return
          }
        }
      }

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
      await window.electronAPI.workspace.setActive(id)
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
        this.openedTextFileContents = {}
        this.activeSidebarPanel = DEFAULT_ACTIVE_SIDEBAR_PANEL
        this.fileSessions = {}
        return
      }
      this.expandedDirs = Array.isArray(metaResult.data.expandedDirs) ? metaResult.data.expandedDirs : []
      this.selectedPaths = Array.isArray(metaResult.data.selectedPaths) ? metaResult.data.selectedPaths.map(normalizeDir) : []
      this.noteOrder = metaResult.data.noteOrder || {}
      this.openedFiles = Array.isArray(metaResult.data.openedFiles) ? metaResult.data.openedFiles.map(normalizeDir) : []
      this.fileSessions = metaResult.data.fileSessions || {}
      this.openedTextFileContents = {}
      this.activeSidebarPanel = resolveActiveSidebarPanel(
        metaResult.data.activeSidebarPanel,
        metaResult.data.sidebarPanels,
      )
      
      // Restore active file
      if (metaResult.data.activeFile && this.openedFiles.includes(metaResult.data.activeFile)) {
        await this.setActiveFileRelative(metaResult.data.activeFile)
      } else if (this.openedFiles.length > 0) {
        await this.setActiveFileRelative(this.openedFiles[this.openedFiles.length - 1])
      }
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
        if (r.error && r.error.includes('Directory not found')) {
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
      const ws = this.activeWorkspace
      if (!ws) return
      const rel = normalizeDir(relativePath)
      this.activeFileRelativePath = rel
      if (!rel) {
        this.resetActiveFileState()
        return
      }
      
      if (!this.openedFiles.includes(rel)) {
        this.openedFiles.push(rel)
        this.saveWorkspaceMeta().catch(() => {})
      }

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
        
        for (const item of items) {
          if (this.activeFileRelativePath === item.from) {
            this.openedFiles = this.openedFiles.filter(of => of !== item.from)
            this.setActiveFileRelative(item.to)
            break
          }
        }
        
        if (this.syncOpenedFilesAfterMove(items)) {
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
      
      // Update openedFiles
      const renamedIdx = this.openedFiles.indexOf(from)
      if (renamedIdx > -1) {
        this.openedFiles.splice(renamedIdx, 1, to)
        this.saveWorkspaceMeta().catch(() => {})
      }

      if (this.activeFileRelativePath === from) this.setActiveFileRelative(to)
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
