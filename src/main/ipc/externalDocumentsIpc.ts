import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ExternalDocuments } from '../services/file/externalDocuments'
import { workspaceService } from '../services/workspace/workspaceService'
import { chooseOpenTarget, workspaceRelativePath, type OpenWindowState } from '../services/app/openWithRouting'

export function createOpenWithController(createEditorWindow: () => BrowserWindow) {
  const states = new Map<number, OpenWindowState>()
  const registered = new Set<number>()
  const pending: string[] = []
  let service: ExternalDocuments | undefined
  let draining = false
  let started = false
  const documents = () => service ??= new ExternalDocuments(path.join(app.getPath('userData'), 'external-document-drafts'))
  function register(win: BrowserWindow) {
    const owner = win.webContents.id
    registered.add(owner)
    win.on('focus', () => {
      const state = states.get(owner)
      if (state) state.focusedAt = Date.now()
    })
    win.on('closed', () => {
      registered.delete(owner)
      states.delete(owner)
      documents().releaseOwner(owner)
    })
  }
  async function drain() {
    if (!started || draining || !pending.length) return
    if (!registered.size) { createEditorWindow(); return }
    // Do not route until all opening windows have reported restored workspace tabs.
    if ([...registered].some(id => !states.has(id))) return
    draining = true
    try {
      while (pending.length) {
        const file = pending.shift()!
        try {
          const canonical = await fs.realpath(file)
          const existingOwner = documents().ownerFor(canonical)
          const target = existingOwner ? { owner: existingOwner } : chooseOpenTarget(canonical, [...states.values()])
          if (!target) { pending.unshift(file); break }
          const win = BrowserWindow.getAllWindows().find(win => win.webContents.id === target.owner)
          if (!win || win.isDestroyed()) { pending.unshift(file); break }
          if (win.isMinimized()) win.restore()
          win.focus()
          if (target.relativePath) {
            win.webContents.send('externalDocuments:open', { kind: 'workspace', relativePath: target.relativePath })
          } else {
            const document = await documents().open(canonical, target.owner)
            win.webContents.send('externalDocuments:open', { kind: 'external', document })
          }
        } catch (error) {
          await dialog.showMessageBox({ type: 'error', message: '无法打开 Markdown 文件', detail: `${file}\n${String(error)}` })
        }
      }
    } finally { draining = false }
  }
  function enqueue(files: string[]) {
    pending.push(...files.filter(file => path.extname(file).toLowerCase() === '.md'))
    void drain()
  }
  ipcMain.handle('externalDocuments:ready', async (event, workspaceId: string | null, opened: string[]) => {
    const owner = event.sender.id
    if (!registered.has(owner)) throw new Error('未知窗口')
    const workspaces = await workspaceService.getState()
    const workspace = workspaceId ? workspaces.data?.workspaces.find(ws => ws.id === workspaceId) : undefined
    const workspacePath = workspace ? await fs.realpath(workspace.path) : undefined
    const paths: string[] = []
    const openedRelativePaths: Record<string, string> = {}
    if (workspacePath && Array.isArray(opened)) {
      for (const relative of opened) {
        if (typeof relative !== 'string' || path.isAbsolute(relative) || !workspaceRelativePath(path.resolve(workspacePath, relative), workspacePath)) continue
        const full = await fs.realpath(path.join(workspacePath, relative)).catch(() => '')
        if (full) { paths.push(full); openedRelativePaths[full] = relative }
      }
    }
    states.set(owner, { id: owner, workspacePath, opened: paths, openedRelativePaths, focusedAt: states.get(owner)?.focusedAt ?? Date.now() })
    void drain()
  })
  ipcMain.handle('externalDocuments:save', (event, id: string, content: string, expected: string) => documents().save(id, event.sender.id, content, expected))
  ipcMain.handle('externalDocuments:draft', (event, id: string, content: string, base: string) => documents().draft(id, event.sender.id, content, base))
  ipcMain.handle('externalDocuments:close', (event, id: string) => documents().close(id, event.sender.id))
  ipcMain.handle('externalDocuments:readCurrent', (event, id: string) => documents().readCurrent(id, event.sender.id))
  return {
    register, enqueue,
    hasPending: () => pending.length > 0,
    async start() {
      pending.push(...await documents().recoveryPaths())
      started = true
      void drain()
    },
  }
}
