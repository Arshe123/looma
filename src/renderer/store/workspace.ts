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
  selectedPaths: string[]
  noteOrder: Record<string, string[]>
}

type UndoAction =
  | { type: 'create'; workspaceId: string; relativePath: string }
  | { type: 'move'; workspaceId: string; items: { from: string; to: string }[] }
  | { type: 'delete'; workspaceId: string; items: { trashRelativePath: string; restoreTo: string }[] }

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
    selectedPaths: [] as string[],
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
      const currentDir = state.selectedPaths[0] ? (state.dirEntries[`${ws}:${normalizeDir(state.selectedPaths[0])}`] ? state.selectedPaths[0] : pathDir(state.selectedPaths[0])) : ''
      const key = `${ws}:${normalizeDir(currentDir)}`
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
      if (this.selectedPaths.length > 0) {
        for (const p of this.selectedPaths) {
           await this.loadDir(id, pathDir(p))
        }
      }
      await window.electronAPI.fs.watchStart(id)
      this.watchedWorkspaceId = id
      this.attachFsEvents()
    },

    async loadWorkspaceMeta(id: string) {
      const metaResult = await window.electronAPI.workspaceMeta.get(id)
      if (!metaResult.success || !metaResult.data) {
        this.expandedDirs = []
        this.selectedPaths = []
        this.noteOrder = {}
        return
      }
      this.expandedDirs = Array.isArray(metaResult.data.expandedDirs) ? metaResult.data.expandedDirs : []
      this.selectedPaths = Array.isArray(metaResult.data.selectedPaths) ? metaResult.data.selectedPaths.map(normalizeDir) : []
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
        selectedPaths: this.selectedPaths.map(normalizeDir),
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
      const currentDir = this.selectedPaths[0] ? (this.dirEntries[`${ws}:${normalizeDir(this.selectedPaths[0])}`] ? this.selectedPaths[0] : pathDir(this.selectedPaths[0])) : ''
      const targetDir = normalizeDir(dirRelativePath ?? currentDir) || '.'
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
      await this.loadDir(ws, currentDir)
      this.setActiveFileRelative(r.data)
    },

    async createFolder(name?: string, dirRelativePath?: string) {
      const ws = this.activeWorkspaceId
      if (!ws) return
      const folderName = ((name ?? (await this.requestTextInput('新建文件夹', 'New Folder'))) ?? '').trim()
      if (!folderName) return
      const currentDir = this.selectedPaths[0] ? (this.dirEntries[`${ws}:${normalizeDir(this.selectedPaths[0])}`] ? this.selectedPaths[0] : pathDir(this.selectedPaths[0])) : ''
      const targetDir = normalizeDir(dirRelativePath ?? currentDir) || '.'
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
      await this.loadDir(ws, currentDir)
    },

    async deleteEntries(relativePaths: string[]) {
      const ws = this.activeWorkspaceId
      this.setBusy(true, '删除中...')
      
      const items: { trashRelativePath: string; restoreTo: string }[] = []
      for (const p of relativePaths) {
        const r = await window.electronAPI.fs.delete(ws, normalizeDir(p))
        if (r.success && r.data) {
          items.push({ trashRelativePath: r.data.trashRelativePath, restoreTo: normalizeDir(p) })
        } else {
          this.setError(r.error || 'Failed to delete')
        }
      }
      this.setBusy(false)
      
      if (items.length > 0) {
        this.undoStack.unshift({
          type: 'delete',
          workspaceId: ws,
          items
        })
        this.redoStack = []
        const currentDir = this.selectedPaths[0] ? (this.dirEntries[`${ws}:${normalizeDir(this.selectedPaths[0])}`] ? this.selectedPaths[0] : pathDir(this.selectedPaths[0])) : ''
        await this.loadDir(ws, currentDir)
        
        const deletedPaths = items.map(i => i.restoreTo)
        const isActiveFileDeleted = deletedPaths.some(dp => 
          this.activeFileRelativePath === dp || this.activeFileRelativePath.startsWith(dp + '/')
        )
        if (isActiveFileDeleted) {
          this.activeFileRelativePath = ''
          this.activeFilePath = ''
        }
        
        const remainingPaths = this.selectedPaths.filter(p => 
          !deletedPaths.some(dp => p === dp || p.startsWith(dp + '/'))
        )
        if (remainingPaths.length !== this.selectedPaths.length) {
          this.selectedPaths = remainingPaths
          this.saveWorkspaceMeta().catch(console.error)
        }
      }
    },

    async moveEntries(fromRelativePaths: string[], targetDirRelativePath: string) {
      const ws = this.activeWorkspaceId
      if (!ws || fromRelativePaths.length === 0) return
      
      this.setBusy(true, '移动中...')
      
      const items: { from: string; to: string }[] = []
      for (const fromRelative of fromRelativePaths) {
        const name = fromRelative.split('/').pop() || fromRelative
        const toRelative = (targetDirRelativePath ? `${targetDirRelativePath}/${name}` : name).replace(/\/{2,}/g, '/')
        
        if (normalizeDir(fromRelative) === normalizeDir(toRelative)) continue
        
        const r = await window.electronAPI.fs.move(ws, normalizeDir(fromRelative), normalizeDir(toRelative))
        if (r.success) {
          items.push({ from: normalizeDir(fromRelative), to: normalizeDir(toRelative) })
        } else {
          this.setError(r.error || 'Failed to move')
        }
      }
      this.setBusy(false)
      
      if (items.length > 0) {
        this.undoStack.unshift({ type: 'move', workspaceId: ws, items })
        this.redoStack = []
        
        const currentDir = this.selectedPaths[0] ? (this.dirEntries[`${ws}:${normalizeDir(this.selectedPaths[0])}`] ? this.selectedPaths[0] : pathDir(this.selectedPaths[0])) : ''
        await this.loadDir(ws, currentDir)
        await this.loadDir(ws, targetDirRelativePath)
        
        const remainingPaths = this.selectedPaths.filter(p => !items.some(i => i.from === p))
        if (remainingPaths.length !== this.selectedPaths.length) {
          this.selectedPaths = remainingPaths
          this.saveWorkspaceMeta().catch(console.error)
        }
        
        for (const item of items) {
          if (this.activeFileRelativePath === item.from) {
            this.setActiveFileRelative(item.to)
            break
          }
        }
      }
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
        this.setBusy(false)
        if (r.success && r.data) {
          this.redoStack.unshift({ type: 'delete', workspaceId: ws, items: [{ trashRelativePath: r.data.trashRelativePath, restoreTo: action.relativePath }] })
        }
      }
      if (action.type === 'move') {
        const reversedItems: { from: string; to: string }[] = []
        for (const item of action.items) {
          const r = await window.electronAPI.fs.move(ws, item.to, item.from)
          if (r.success) reversedItems.push({ from: item.to, to: item.from })
        }
        if (reversedItems.length > 0) this.redoStack.unshift({ type: 'move', workspaceId: ws, items: reversedItems })
      }
      if (action.type === 'delete') {
        this.setBusy(true, '恢复中...')
        const restoredItems: { trashRelativePath: string; restoreTo: string }[] = []
        for (const item of action.items) {
          const r = await window.electronAPI.fs.restore(ws, item.trashRelativePath, item.restoreTo)
          if (r.success) restoredItems.push(item)
        }
        this.setBusy(false)
        if (restoredItems.length > 0) this.redoStack.unshift({ ...action, items: restoredItems })
      }
      const currentDir = this.selectedPaths[0] ? (this.dirEntries[`${ws}:${normalizeDir(this.selectedPaths[0])}`] ? this.selectedPaths[0] : pathDir(this.selectedPaths[0])) : ''
      if (this.activeWorkspaceId) await this.loadDir(this.activeWorkspaceId, currentDir)
    },

    async redo() {
      const action = this.redoStack.shift()
      if (!action) return
      const ws = action.workspaceId
      if (action.type === 'delete') {
        this.setBusy(true, '删除中...')
        const newItems: { trashRelativePath: string; restoreTo: string }[] = []
        for (const item of action.items) {
          const r = await window.electronAPI.fs.delete(ws, item.restoreTo)
          if (r.success && r.data) newItems.push({ trashRelativePath: r.data.trashRelativePath, restoreTo: item.restoreTo })
        }
        this.setBusy(false) 
        if (newItems.length > 0) this.undoStack.unshift({ type: 'delete', workspaceId: ws, items: newItems })
      }
      if (action.type === 'move') {
        const reversedItems: { from: string; to: string }[] = []
        for (const item of action.items) {
          const r = await window.electronAPI.fs.move(ws, item.to, item.from)
          if (r.success) reversedItems.push({ from: item.to, to: item.from })
        }
        if (reversedItems.length > 0) this.undoStack.unshift({ type: 'move', workspaceId: ws, items: reversedItems })
      }
      if (action.type === 'create') {
        await this.createMarkdown(pathBase(action.relativePath))
      }
      const currentDir = this.selectedPaths[0] ? (this.dirEntries[`${ws}:${normalizeDir(this.selectedPaths[0])}`] ? this.selectedPaths[0] : pathDir(this.selectedPaths[0])) : ''
      if (this.activeWorkspaceId) await this.loadDir(this.activeWorkspaceId, currentDir)
    },

    attachFsEvents() {
      if (this.fsUnsub) return
      this.fsUnsub = window.electronAPI.fs.onEvent((payload) => {
        if (payload.workspaceId !== this.activeWorkspaceId) return
        const affected = normalizeDir(pathDir(payload.relativePath))
        const key = `${payload.workspaceId}:${affected}`
        if (this.dirEntries[key]) this.loadDir(payload.workspaceId, affected)
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
