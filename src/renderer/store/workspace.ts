import { defineStore } from 'pinia'

export interface Workspace {
  id: string
  name: string
  path: string
  createdAt: number
  lastOpenedAt: number
}

export interface FsEntry {
  name: string
  relativePath: string
  isDirectory: boolean
  size: number
  mtimeMs: number
}

export interface WorkspaceMeta {
  expandedDirs: string[]
  selectedDir: string
  noteOrder: Record<string, string[]>
}

type UndoAction =
  | { type: 'create'; workspaceId: string; relativePath: string }
  | { type: 'move'; workspaceId: string; from: string; to: string }
  | { type: 'delete'; workspaceId: string; trashRelativePath: string; restoreTo: string }

const normalizeDir = (p: string) => {
  const x = (p || '').trim().split('\\').join('/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!x) return ''
  if (x === '.' || x === './') return ''
  return x
}

let pendingTextInputResolve: ((value: string | null) => void) | null = null

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    workspaces: [] as Workspace[],
    activeWorkspaceId: null as string | null,
    activeFilePath: '' as string,
    activeFileRelativePath: '' as string,
    selectedDir: '' as string,
    expandedDirs: [] as string[],
    noteOrder: {} as Record<string, string[]>,
    dirEntries: {} as Record<string, FsEntry[]>,
    isBusy: false as boolean,
    busyText: '' as string,
    lastError: '' as string,
    undoStack: [] as UndoAction[],
    redoStack: [] as UndoAction[],
    theme: (localStorage.getItem('theme') || 'light') as 'light' | 'dark',
    hasElectronWindowAPI: false as boolean,
    watchedWorkspaceId: null as string | null,
    fsUnsub: null as null | (() => void),
    inputDialogOpen: false as boolean,
    inputDialogTitle: '' as string,
    inputDialogPlaceholder: '' as string,
    inputDialogValue: '' as string,
  }),
  getters: {
    activeWorkspace(state) {
      return state.workspaces.find((w) => w.id === state.activeWorkspaceId) || null
    },
    keyOfDir: () => (workspaceId: string, dir: string) => `${workspaceId}:${normalizeDir(dir)}`,
    activeDirEntries(state): FsEntry[] {
      const ws = state.activeWorkspaceId
      if (!ws) return []
      const key = `${ws}:${normalizeDir(state.selectedDir)}`
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
      this.theme = this.theme === 'light' ? 'dark' : 'light'
      localStorage.setItem('theme', this.theme)
      this.applyTheme()
    },
    applyTheme() {
      if (this.theme === 'dark') document.documentElement.classList.add('dark')
      else document.documentElement.classList.remove('dark')
    },

    setBusy(isBusy: boolean, text = '') {
      this.isBusy = isBusy
      this.busyText = text
    },

    setError(message: string) {
      this.lastError = message
    },

    clearError() {
      this.lastError = ''
    },

    async init() {
      this.applyTheme()
      if (!((window as any).electronAPI && (window as any).electronAPI.workspace)) {
        this.setError('请使用 Electron 启动应用')
        return
      }
      const wsFromUrl = new URLSearchParams(window.location.search).get('workspaceId')
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
        return
      }

      if (this.activeWorkspaceId) {
        await this.switchWorkspace(this.activeWorkspaceId)
      }

      this.hasElectronWindowAPI = Boolean((window as any).electronAPI?.window)
    },

    async createWorkspaceFlow() {
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
      await this.switchWorkspace(result.data.id)
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

    async switchWorkspace(id: string) {
      if (!id) return
      const prev = this.watchedWorkspaceId
      if (prev && prev !== id) {
        await window.electronAPI.fs.watchStop(prev)
      }
      this.activeFilePath = ''
      this.activeFileRelativePath = ''
      this.activeWorkspaceId = id
      await window.electronAPI.workspace.setActive(id)
      await this.loadWorkspaceMeta(id)
      await this.loadDir(id, '')
      if (normalizeDir(this.selectedDir)) {
        await this.loadDir(id, this.selectedDir)
      }
      await window.electronAPI.fs.watchStart(id)
      this.watchedWorkspaceId = id
      this.attachFsEvents()
    },

    async loadWorkspaceMeta(id: string) {
      const metaResult = await window.electronAPI.workspaceMeta.get(id)
      if (!metaResult.success || !metaResult.data) {
        this.expandedDirs = []
        this.selectedDir = ''
        this.noteOrder = {}
        return
      }
      this.expandedDirs = Array.isArray(metaResult.data.expandedDirs) ? metaResult.data.expandedDirs : []
      this.selectedDir = normalizeDir(metaResult.data.selectedDir)
      this.noteOrder = metaResult.data.noteOrder || {}
    },

    async saveWorkspaceMeta() {
      const id = this.activeWorkspaceId
      if (!id) return
      const noteOrderPlain: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(this.noteOrder || {})) {
        noteOrderPlain[k] = Array.isArray(v) ? v.slice() : []
      }
      const meta: WorkspaceMeta = {
        expandedDirs: this.expandedDirs.map(normalizeDir),
        selectedDir: normalizeDir(this.selectedDir),
        noteOrder: noteOrderPlain,
      }
      await window.electronAPI.workspaceMeta.set(id, meta)
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

    async removeWorkspace(id: string) {
      const ws = this.workspaces.find((w) => w.id === id)
      if (!ws) return
      const ok = window.confirm(`从列表移除工作空间：${ws.name}？`)
      if (!ok) return
      const r = await window.electronAPI.workspace.remove(id)
      if (!r.success) this.setError(r.error || 'Failed to remove workspace')
      await this.refreshWorkspaces()
      if (this.activeWorkspaceId) await this.switchWorkspace(this.activeWorkspaceId)
    },

    async loadDir(workspaceId: string, dirRelativePath: string) {
      const dir = normalizeDir(dirRelativePath)
      const r = await window.electronAPI.fs.listDir(workspaceId, dir || '.')
      if (!r.success || !r.data) {
        this.setError(r.error || 'Failed to list directory')
        return
      }
      this.dirEntries[`${workspaceId}:${dir}`] = r.data
    },

    async selectDir(dirRelativePath: string) {
      const ws = this.activeWorkspaceId
      if (!ws) return
      this.selectedDir = normalizeDir(dirRelativePath)
      await this.loadDir(ws, this.selectedDir)
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
        this.activeFilePath = ''
        return
      }
      const sep = pathSep(ws.path)
      const root = ws.path.endsWith(sep) ? ws.path.slice(0, -1) : ws.path
      this.activeFilePath = `${root}${sep}${rel.split('/').join(sep)}`
    },

    async createMarkdown(title?: string, dirRelativePath?: string) {
      const ws = this.activeWorkspaceId
      if (!ws) return
      const name = ((title ?? (await this.requestTextInput('新建 Markdown 文件', 'Untitled'))) ?? '').trim()
      if (!name) return
      const targetDir = normalizeDir(dirRelativePath ?? this.selectedDir) || '.'
      this.setBusy(true, '创建中...')
      const r = await window.electronAPI.fs.createFile(ws, targetDir, name)
      this.setBusy(false)
      if (!r.success || !r.data) {
        this.setError(r.error || 'Failed to create file')
        return
      }
      this.undoStack.unshift({ type: 'create', workspaceId: ws, relativePath: r.data })
      this.redoStack = []
      await this.loadDir(ws, normalizeDir(pathDir(r.data)))
      await this.loadDir(ws, this.selectedDir)
      this.setActiveFileRelative(r.data)
    },

    async createFolder(name?: string, dirRelativePath?: string) {
      const ws = this.activeWorkspaceId
      if (!ws) return
      const folderName = ((name ?? (await this.requestTextInput('新建文件夹', 'New Folder'))) ?? '').trim()
      if (!folderName) return
      const targetDir = normalizeDir(dirRelativePath ?? this.selectedDir) || '.'
      this.setBusy(true, '创建中...')
      const r = await window.electronAPI.fs.createFolder(ws, targetDir, folderName)
      this.setBusy(false)
      if (!r.success || !r.data) {
        this.setError(r.error || 'Failed to create folder')
        return
      }
      this.undoStack.unshift({ type: 'create', workspaceId: ws, relativePath: r.data })
      this.redoStack = []
      await this.loadDir(ws, normalizeDir(pathDir(r.data)))
      await this.loadDir(ws, this.selectedDir)
    },

    async deleteEntry(relativePath: string) {
      const ws = this.activeWorkspaceId
      if (!ws) return
      const ok = window.confirm('确认删除？')
      if (!ok) return
      this.setBusy(true, '删除中...')
      const r = await window.electronAPI.fs.delete(ws, normalizeDir(relativePath))
      this.setBusy(false)
      if (!r.success || !r.data) {
        this.setError(r.error || 'Failed to delete')
        return
      }
      this.undoStack.unshift({
        type: 'delete',
        workspaceId: ws,
        trashRelativePath: r.data.trashRelativePath,
        restoreTo: normalizeDir(relativePath),
      })
      this.redoStack = []
      await this.loadDir(ws, this.selectedDir)
      if (this.activeFileRelativePath === normalizeDir(relativePath)) {
        this.activeFileRelativePath = ''
        this.activeFilePath = ''
      }
    },

    async moveEntry(fromRelative: string, toRelative: string) {
      const ws = this.activeWorkspaceId
      if (!ws) return
      this.setBusy(true, '移动中...')
      const r = await window.electronAPI.fs.move(ws, normalizeDir(fromRelative), normalizeDir(toRelative))
      if (!r.success) {
        this.setBusy(false)
        this.setError(r.error || 'Failed to move')
        return
      }
      this.setBusy(false)
      this.undoStack.unshift({ type: 'move', workspaceId: ws, from: normalizeDir(toRelative), to: normalizeDir(fromRelative) })
      this.redoStack = []
      await this.loadDir(ws, this.selectedDir)
    },

    async renameEntry(relativePath: string) {
      const ws = this.activeWorkspaceId
      if (!ws) return
      const from = normalizeDir(relativePath)
      const base = pathBase(from)
      const nextBase = ((await this.requestTextInput('重命名', base)) ?? base).trim()
      if (!nextBase || nextBase === base) return
      const dir = pathDir(from)
      const to = dir ? `${dir}/${nextBase}` : nextBase
      const r = await window.electronAPI.fs.rename(ws, from, nextBase)
      if (!r.success) {
        this.setError(r.error || 'Failed to rename')
        return
      }
      if (this.activeFileRelativePath === from) this.setActiveFileRelative(to)
    },

    async undo() {
      const action = this.undoStack.shift()
      if (!action) return
      const ws = action.workspaceId
      if (action.type === 'create') {
        this.setBusy(true, '删除中...')
        const r = await window.electronAPI.fs.delete(ws, action.relativePath)
        if (r.success && r.data) {
          this.redoStack.unshift({ type: 'delete', workspaceId: ws, trashRelativePath: r.data.trashRelativePath, restoreTo: action.relativePath })
        }
      }
      if (action.type === 'move') {
        const r = await window.electronAPI.fs.move(ws, action.from, action.to)
        if (r.success) this.redoStack.unshift({ type: 'move', workspaceId: ws, from: action.to, to: action.from })
      }
      if (action.type === 'delete') {
        const r = await window.electronAPI.fs.restore(ws, action.trashRelativePath, action.restoreTo)
        if (r.success) this.redoStack.unshift(action)
      }
      if (this.activeWorkspaceId) await this.loadDir(this.activeWorkspaceId, this.selectedDir)
    },

    async redo() {
      const action = this.redoStack.shift()
      if (!action) return
      const ws = action.workspaceId
      if (action.type === 'delete') {
        this.setBusy(true, '删除中...')
        const r = await window.electronAPI.fs.delete(ws, action.restoreTo)
        this.setBusy(false) 
        if (r.success && r.data) this.undoStack.unshift({ type: 'delete', workspaceId: ws, trashRelativePath: r.data.trashRelativePath, restoreTo: action.restoreTo })
      }
      if (action.type === 'move') {
        const r = await window.electronAPI.fs.move(ws, action.from, action.to)
        if (r.success) this.undoStack.unshift({ type: 'move', workspaceId: ws, from: action.to, to: action.from })
      }
      if (action.type === 'create') {
        await this.createMarkdown(pathBase(action.relativePath))
      }
      if (this.activeWorkspaceId) await this.loadDir(this.activeWorkspaceId, this.selectedDir)
    },

    attachFsEvents() {
      if (this.fsUnsub) return
      this.fsUnsub = window.electronAPI.fs.onEvent((payload) => {
        if (payload.workspaceId !== this.activeWorkspaceId) return
        const affected = normalizeDir(pathDir(payload.relativePath))
        const key = `${payload.workspaceId}:${affected}`
        if (this.dirEntries[key]) this.loadDir(payload.workspaceId, affected)
        if (affected === normalizeDir(this.selectedDir)) this.loadDir(payload.workspaceId, this.selectedDir)
      })
    },
  },
})

const pathSep = (p: string) => (p.includes('\\') ? '\\' : '/')
const pathDir = (p: string) => {
  const x = normalizeDir(p)
  const idx = x.lastIndexOf('/')
  return idx === -1 ? '' : x.slice(0, idx)
}
const pathBase = (p: string) => {
  const x = normalizeDir(p)
  const idx = x.lastIndexOf('/')
  return idx === -1 ? x : x.slice(idx + 1)
}
