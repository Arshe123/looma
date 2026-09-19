import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExternalDocumentData, DocumentHandoff } from '../../shared/types/external-document'
import { ExternalDocuments } from '../services/file/externalDocuments'
import { workspaceService } from '../services/workspace/workspaceService'
import { chooseOpenTarget, workspaceRelativePath, type OpenWindowState } from '../services/app/openWithRouting'

export function createOpenWithController(createEditorWindow: () => BrowserWindow, createWorkspaceWindow: (id: string) => BrowserWindow) {
  const states = new Map<number, OpenWindowState>()
  const registered = new Set<number>()
  const handoffs = new Map<string, { source: number; target: number; request: DocumentHandoff; document: ExternalDocumentData; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; sent: boolean }>()
  function deliverHandoffs() {
    for (const item of handoffs.values()) {
      if (item.sent || !states.has(item.target)) continue
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.id === item.target)
      if (!win || win.isDestroyed()) continue
      item.sent = true
      win.webContents.send('externalDocuments:handoff', item.request)
    }
  }
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
      for (const [token, item] of handoffs) {
        if (item.source !== owner && item.target !== owner) continue
        clearTimeout(item.timer)
        handoffs.delete(token)
        item.reject(new Error('交接窗口已关闭，原草稿已保留'))
      }
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
          const target = existingOwner ? chooseOpenTarget(canonical, [...states.values()].filter(state => state.id === existingOwner)) : chooseOpenTarget(canonical, [...states.values()])
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
    deliverHandoffs()
    void drain()
  })
  ipcMain.handle('externalDocuments:transfer', async (event, workspaceId: string, id: string, content: string, baseContent: string) => {
    const source = event.sender.id
    if ([...handoffs.values()].some(item => item.source === source || item.target === source)) throw new Error('交接正在进行')
    const filePath = documents().pathFor(id, source)
    const exists = await workspaceService.checkExists(workspaceId)
    if (!exists.success || !exists.data?.exists) throw new Error('工作空间不可用')
    const state = await workspaceService.getState()
    const workspace = state.data?.workspaces.find(ws => ws.id === workspaceId)
    if (!workspace) throw new Error('工作空间不存在')
    const root = await fs.realpath(workspace.path)
    // This is a recovery write, not a save to the original file.
    await documents().draft(id, source, content, baseContent)
    const target = BrowserWindow.getAllWindows().find(win => win.webContents.id !== source && (
      states.get(win.webContents.id)?.workspacePath === root || new URL(win.webContents.getURL() || 'about:blank').searchParams.get('workspaceId') === workspaceId
    )) || createWorkspaceWindow(workspaceId)
    const token = randomUUID()
    const relativePath = workspaceRelativePath(filePath, root)
    const request = { token, workspaceId, relativePath, document: { id, filePath, content, baseContent } }
    if (target.isMinimized()) target.restore()
    target.focus()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { handoffs.delete(token); reject(new Error('工作空间未能及时接收文件；原文件仍在当前窗口')) }, 20000)
      handoffs.set(token, { source, target: target.webContents.id, request, document: { id, filePath, content, baseContent }, resolve, reject, timer, sent: false })
      deliverHandoffs()
    })
  })
  ipcMain.handle('externalDocuments:claim', (event, token: string, error?: string) => {
    const item = handoffs.get(token)
    if (!item || item.target !== event.sender.id) throw new Error('交接已失效')
    try {
      if (error) throw new Error(error)
      documents().transferOwner(item.document.id, item.source, item.target)
      item.resolve()
      return item.document
    } catch (error) {
      item.reject(error instanceof Error ? error : new Error(String(error)))
      return null
    } finally { clearTimeout(item.timer); handoffs.delete(token) }
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
