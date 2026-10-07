import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { MemoryCleanupSelection, MemoryCleanupPreview } from '../../../shared/types/agent-memory'
import { MAX_MEMORY_CHARS, type AgentMemoryInvalidation, type AgentMemoryKind, type AgentMemoryDocument, type AgentMemorySnapshot, type UserProfileHistoryEntry, type UserProfileHistoryPage } from '../../../shared/types/agent-memory'

import type { MemoryUpdatedPayload } from '../../../shared/types/agent-events'
export interface MemoryReceiptContext { workspaceId: string; taskId: string; runId: string }
export interface MemoryReceipt extends MemoryReceiptContext { id: string; timestamp: number; change: MemoryUpdatedPayload }
type StoredReceipt = MemoryReceipt & { status: 'pending' | 'committed' }
const receiptId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const revision = (content: string | Buffer) => createHash('sha256').update(content).digest('hex')
const queues = new Map<string, Promise<unknown>>()
const generations = new Map<string, number>()
const subscribers = new Map<string, Set<(event: AgentMemoryInvalidation) => void>>()
const historyId = /^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
export class AgentMemoryError extends Error {}
export class AgentMemoryConflictError extends AgentMemoryError {}
export class AgentMemoryAuthorizationError extends AgentMemoryError {}
class UserProfileHistoryRecordError extends AgentMemoryError {}
function validateContent(content: unknown): asserts content is string {
  if (typeof content !== 'string' || content.length > MAX_MEMORY_CHARS || content.includes('\0')) throw new AgentMemoryError('记忆内容无效或过长。')
}
export class AgentMemoryStore {
  static subscribe(root: string, listener: (event: AgentMemoryInvalidation) => void) {
    const key = path.resolve(root)
    const listeners = subscribers.get(key) ?? new Set()
    listeners.add(listener); subscribers.set(key, listeners)
    return () => { listeners.delete(listener); if (!listeners.size) subscribers.delete(key) }
  }
  private invalidate(event: AgentMemoryInvalidation) {
    for (const listener of subscribers.get(path.resolve(this.root)) ?? []) {
      // A disconnected observer cannot change the outcome of a durable save.
      try { listener(event) } catch { /* observer isolated */ }
    }
  }
  constructor(private readonly root: string, private readonly io: { rename?: typeof fs.rename; syncDirectory?: (directory: string) => Promise<void> } = {}) {}
  get generation() { return generations.get(path.resolve(this.root)) ?? 0 }
  async recover() { await this.locked(async () => {}) }
  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.root)
    const guarded = async () => { await this.recoverCleanup(); return operation() }
    const next = (queues.get(key) ?? Promise.resolve()).then(guarded, guarded)
    queues.set(key, next)
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key) }).catch(() => {})
    return next
  }
  private file(kind: AgentMemoryKind) {
    if (kind !== 'soul' && kind !== 'user') throw new AgentMemoryError('记忆类型无效。')
    return path.join(this.root, `${kind}.md`)
  }
  async snapshot(workspaceId: string, conversationId: string, requireExisting = false): Promise<AgentMemorySnapshot> {
    return this.locked(async () => {
      const file = path.join(this.root, 'memory-snapshots', `${revision(JSON.stringify([workspaceId, conversationId]))}.json`)
      try {
        await this.safePath(path.relative(this.root, file).split(path.sep).join('/'))
        const snapshot = JSON.parse(await fs.readFile(file, 'utf8')) as AgentMemorySnapshot
        for (const kind of ['soul', 'user'] as const) {
          validateContent(snapshot?.[kind]?.content)
          if (snapshot[kind].revision !== revision(snapshot[kind].content)) throw new AgentMemoryError('记忆快照已损坏。')
        }
        return snapshot
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (requireExisting) throw new AgentMemoryError('原对话记忆快照缺失，请新建对话。')
      const snapshot = { soul: await this.read('soul'), user: await this.read('user') }
      await this.atomicWrite(file, JSON.stringify(snapshot))
      return snapshot
    })
  }
  async read(kind: AgentMemoryKind): Promise<AgentMemoryDocument> {
    let content: string
    try {
      const file = this.file(kind)
      await this.safePath(path.basename(file))
      content = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      content = ''
    }
    validateContent(content)
    return { content, revision: revision(content) }
  }
  async save(kind: AgentMemoryKind, content: string, expectedRevision: string, authorize?: () => boolean, receipt?: MemoryReceipt): Promise<AgentMemoryDocument> {
    const generation = this.generation
    return this.locked(async () => {
      if (generation !== this.generation) throw new AgentMemoryConflictError('记忆已清理，请重新加载后再保存。')
      await this.settleReceipts()
      return this.saveLocked(kind, content, expectedRevision, authorize ? 'agent' : 'manual', authorize, receipt)
    })
  }
  private async saveLocked(kind: AgentMemoryKind, content: string, expectedRevision: string, source: UserProfileHistoryEntry['source'], authorize?: () => boolean, receipt?: MemoryReceipt): Promise<AgentMemoryDocument> {
      const current = await this.read(kind)
      if (authorize && !authorize()) throw new AgentMemoryAuthorizationError('自动维护用户画像已关闭或运行授权已失效。')
      if (current.revision !== expectedRevision) throw new AgentMemoryConflictError('内容已在其他窗口更新，请重新加载后再保存。')
      validateContent(content)
      if (content === current.content) return current
      if (kind === 'user') {
        const ids = await this.historyIds()
        const createdAt = Math.max(Date.now(), Number(ids[0]?.slice(0, 13) ?? 0) + 1)
        const id = `${createdAt}-${randomUUID()}`
        // This backup contains only previously committed content. It remains
        // useful even if authorization, rename, or directory sync later fails.
        await this.atomicWrite(this.historyFile(id), JSON.stringify({ ...current, id, createdAt, source }))
        await this.syncDirectory(this.root)
        // Backing up is not the start of the current-file commit boundary.
        if (authorize && !authorize()) throw new AgentMemoryAuthorizationError('自动维护用户画像已关闭或运行授权已失效。')
      }
      if (receipt) {
        this.validateReceipt({ ...receipt, status: 'pending' })
        if (kind !== 'user' || receipt.change.beforeRevision !== current.revision || receipt.change.afterRevision !== revision(content)) throw new AgentMemoryError('记忆回执与保存内容不匹配。')
        const records = await this.receiptRecords()
        if (records.some(item => item.id === receipt!.id)) throw new AgentMemoryError('记忆回执标识重复。')
        receipt = { ...receipt, timestamp: Math.max(receipt.timestamp, ...records.map(item => item.timestamp + 1)) }
        this.validateReceipt({ ...receipt, status: 'pending' })
        await this.atomicWrite(this.receiptFile(receipt.id), JSON.stringify({ ...receipt, status: 'pending' }))
        await this.syncDirectory(this.root)
        if (authorize && !authorize()) throw new AgentMemoryAuthorizationError('自动维护用户画像已关闭或运行授权已失效。')
      }
      let renamed = false
      try {
        await this.atomicWrite(this.file(kind), content, () => { renamed = true })
        if (receipt) await this.atomicWrite(this.receiptFile(receipt.id), JSON.stringify({ ...receipt, status: 'committed' }))
      } catch (error) { if (renamed) this.invalidate({ kind }); throw error }
      this.invalidate({ kind, revision: revision(content) })
      return { content, revision: revision(content) }
  }
  private historyFile(id: string) {
    if (typeof id !== 'string' || !historyId.test(id)) throw new AgentMemoryError('历史版本标识无效。')
    return path.join(this.root, 'user-history', `${id}.json`)
  }
  private async historyIds() {
    try {
      await this.validateHistoryDirectory()
      return (await fs.readdir(path.join(this.root, 'user-history'))).filter(name => name.endsWith('.json') && historyId.test(name.slice(0, -5))).map(name => name.slice(0, -5)).sort().reverse()
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  private async validateHistoryDirectory() {
    const stat = await fs.lstat(path.join(this.root, 'user-history'))
    if (!stat.isDirectory()) throw new AgentMemoryError('历史版本目录无效，请检查本机文件后重试。')
  }
  async readUserHistory(id: string): Promise<UserProfileHistoryEntry> {
    const file = this.historyFile(id)
    await this.validateHistoryDirectory()
    try {
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.size > MAX_MEMORY_CHARS * 6 + 1024) throw new Error('invalid file')
      const entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file))) as UserProfileHistoryEntry
      validateContent(entry?.content)
      if (entry.id !== id || entry.revision !== revision(entry.content) || entry.createdAt !== Number(id.slice(0, 13))
        || !['manual', 'agent', 'restore'].includes(entry.source)) throw new Error('invalid entry')
      return { id, createdAt: entry.createdAt, source: entry.source, revision: entry.revision, content: entry.content }
    } catch { throw new UserProfileHistoryRecordError('历史版本缺失或已损坏，未恢复任何内容。') }
  }
  async listUserHistory(cursor?: string): Promise<UserProfileHistoryPage> {
    if (cursor !== undefined) this.historyFile(cursor)
    return this.locked(async () => {
      const ids = (await this.historyIds()).filter(id => cursor === undefined || id < cursor)
      const entries = await Promise.all(ids.slice(0, 20).map(async id => {
        try {
          const { content: _content, ...entry } = await this.readUserHistory(id)
          return { ...entry, status: 'valid' as const }
        } catch (error) {
          if (!(error instanceof UserProfileHistoryRecordError)) throw error
          // Derive metadata only from a validated filename, never damaged bytes.
          return { id, createdAt: Number(id.slice(0, 13)), status: 'invalid' as const, error: '历史版本缺失或已损坏，无法查看或恢复。' }
        }
      }))
      return { entries, ...(ids.length > 20 ? { nextCursor: ids[19] } : {}) }
    })
  }
  async restoreUserHistory(id: string, expectedRevision: string): Promise<AgentMemoryDocument> {
    return this.locked(async () => {
      await this.settleReceipts()
      const entry = await this.readUserHistory(id)
      return this.saveLocked('user', entry.content, expectedRevision, 'restore')
    })
  }
  private receiptFile(id: string) {
    if (!receiptId.test(id)) throw new AgentMemoryError('记忆回执标识无效。')
    return path.join(this.root, 'memory-receipts', `${id}.json`)
  }
  private validateReceipt(value: StoredReceipt) {
    const identifier = (text: unknown) => typeof text === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(text)
    const hash = (text: unknown) => typeof text === 'string' && /^[a-f0-9]{64}$/.test(text)
    const changes = (items: unknown) => Array.isArray(items) && items.length <= MAX_MEMORY_CHARS * 2
      && items.every(item => item && ['added', 'removed'].includes(item.type) && typeof item.text === 'string' && item.text.length <= MAX_MEMORY_CHARS && !item.text.includes('\0'))
    if (!value || !receiptId.test(value.id) || !identifier(value.workspaceId) || !identifier(value.runId) || !identifier(value.taskId)
      || !Number.isSafeInteger(value.timestamp) || value.timestamp < 0 || !['pending', 'committed'].includes(value.status)
      || value.change?.kind !== 'user' || !hash(value.change.beforeRevision) || !hash(value.change.afterRevision)
      || !changes(value.change.changes) || (value.change.net !== undefined && (!value.change.net || !Number.isSafeInteger(value.change.net.segment)
        || value.change.net.segment < 1 || !changes(value.change.net.changes)))) throw new AgentMemoryError('记忆回执日志损坏，请检查本机文件后重试；未继续保存画像。')
  }
  private async receiptRecords(): Promise<StoredReceipt[]> {
    try { await this.safePath('memory-receipts', true) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const result: StoredReceipt[] = []
    for (const name of await fs.readdir(path.join(this.root, 'memory-receipts'))) {
      if (!name.endsWith('.json') || !receiptId.test(name.slice(0, -5))) continue
      await this.safePath(`memory-receipts/${name}`)
      const value = JSON.parse(await fs.readFile(path.join(this.root, 'memory-receipts', name), 'utf8')) as StoredReceipt
      this.validateReceipt(value)
      if (`${value.id}.json` !== name) throw new AgentMemoryError('记忆回执标识不匹配。')
      result.push(value)
    }
    return result.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  }
  private async removeReceipt(id: string) {
    await fs.unlink(this.receiptFile(id))
    await this.syncDirectory(path.join(this.root, 'memory-receipts'))
  }
  private async settleReceipts() {
    const records = await this.receiptRecords()
    for (const item of records) {
      if (item.status !== 'pending') continue
      const current = await this.read('user')
      if (current.revision === item.change.afterRevision) {
        // Every subsequent managed write must settle this evidence FIRST.
        // History backups are deliberately never evidence of a successful save.
        await this.syncDirectory(this.root)
        await this.atomicWrite(this.receiptFile(item.id), JSON.stringify({ ...item, status: 'committed' }))
      } else if (current.revision === item.change.beforeRevision) await this.removeReceipt(item.id)
      else throw new AgentMemoryError('画像与待确认回执不一致，可能被外部修改。请检查本机文件，或在设置中预览并清理待处理记忆；未继续保存。')
    }
  }
  async deliverReceipt(id: string, deliver: (receipt: MemoryReceipt) => Promise<unknown>) {
    return this.locked(async () => {
      await this.settleReceipts()
      const records = await this.receiptRecords()
      const item = records.find(item => item.id === id)
      if (item?.status !== 'committed') return false
      for (const earlier of records) {
        if (earlier.status === 'committed' && earlier.workspaceId === item.workspaceId && earlier.runId === item.runId && earlier.taskId === item.taskId) {
          await deliver(earlier)
          await this.removeReceipt(earlier.id)
        }
        if (earlier.id === id) break
      }
      return true
    })
  }
  async replayReceipts(deliver: (receipt: MemoryReceipt) => Promise<boolean>) {
    return this.locked(async () => {
      await this.settleReceipts()
      for (const item of await this.receiptRecords()) {
        if (item.status === 'committed' && await deliver(item)) await this.removeReceipt(item.id)
      }
    })
  }
  private cleanupSelection(value: MemoryCleanupSelection): MemoryCleanupSelection {
    if (!value || Object.keys(value).sort().join(',') !== 'history,snapshots,user'
      || Object.values(value).some(item => typeof item !== 'boolean') || !Object.values(value).some(Boolean)
      || (value.user && (!value.history || !value.snapshots))) throw new AgentMemoryError('清理范围无效；清除画像必须同时清除历史和对话快照。')
    return { history: value.history, snapshots: value.snapshots, user: value.user }
  }
  private async safePath(relative: string, directory = false) {
    const root = await fs.lstat(this.root)
    if (!root.isDirectory()) throw new AgentMemoryError('记忆目录不能是链接或非目录。')
    const parts = relative.split('/')
    for (let i = 0; i < parts.length; i++) {
      const stat = await fs.lstat(path.join(this.root, ...parts.slice(0, i + 1)))
      if (i < parts.length - 1 || directory) {
        if (!stat.isDirectory()) throw new AgentMemoryError('记忆目录不能是链接或非目录。')
      } else if (!stat.isFile()) throw new AgentMemoryError('记忆记录不能是链接或非普通文件。')
    }
  }
  private managedRecord(relative: string): boolean {
    // A killed atomic write leaves sensitive bytes in a uniquely named temp.
    // Only our exact UUID suffix and an independently valid base are managed.
    if (relative.endsWith('.tmp')) {
      const suffix = relative.slice(-40, -4)
      return receiptId.test(suffix) && relative.at(-41) === '.' && this.managedRecord(relative.slice(0, -41))
    }
    return relative === 'user.md'
      || (relative.startsWith('user-history/') && historyId.test(relative.slice(13, -5)) && relative.endsWith('.json'))
      || /^memory-snapshots\/[a-f0-9]{64}\.json$/.test(relative)
      || (relative.startsWith('memory-receipts/') && relative.endsWith('.json') && receiptId.test(relative.slice(16, -5)))
  }
  private async scanCleanup(selection: MemoryCleanupSelection): Promise<MemoryCleanupPreview> {
    const records: string[] = [], skipped: string[] = [], fingerprints: string[] = []
    const counts = { history: 0, snapshots: 0, user: 0, receipts: 0 }
    const directories = [['history', 'user-history'], ['snapshots', 'memory-snapshots'], ['receipts', 'memory-receipts']] as const
    for (const [kind, directory] of directories) {
      if (kind !== 'receipts' && !selection[kind]) continue
      try { await this.safePath(directory, true) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      for (const name of (await fs.readdir(path.join(this.root, directory))).sort()) {
        const relative = `${directory}/${name}`
        if (!this.managedRecord(relative)) { skipped.push(relative); continue }
        await this.safePath(relative)
        records.push(relative); counts[kind]++
        fingerprints.push(revision(await fs.readFile(path.join(this.root, relative))))
      }
    }
    if (selection.user) {
      for (const name of (await fs.readdir(this.root).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })).sort()) {
        if (!name.startsWith('user.md.') || !this.managedRecord(name)) continue
        await this.safePath(name)
        records.push(name); counts.user++
        fingerprints.push(revision(await fs.readFile(path.join(this.root, name))))
      }
    }
    // Bind even history-only previews to the current profile, including absence.
    try {
      await this.safePath('user.md')
      fingerprints.push(revision(await fs.readFile(this.file('user'))))
      if (selection.user) { records.push('user.md'); counts.user++ }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; fingerprints.push('absent') }
    return { selection, records, skipped, counts, token: revision(JSON.stringify([selection, records, skipped, fingerprints])) }
  }
  async previewCleanup(value: MemoryCleanupSelection) {
    const selection = this.cleanupSelection(value)
    return this.locked(() => this.scanCleanup(selection))
  }
  async cleanup(value: MemoryCleanupSelection, token: string) {
    const selection = this.cleanupSelection(value)
    return this.locked(async () => {
      const preview = await this.scanCleanup(selection)
      if (typeof token !== 'string' || preview.token !== token) throw new AgentMemoryConflictError('清理范围已变化，请重新预览并确认。')
      await this.atomicWrite(path.join(this.root, 'memory-cleanup.json'), JSON.stringify({ version: 1, records: preview.records }))
      await this.recoverCleanup()
    })
  }
  private async recoverCleanup() {
    const file = path.join(this.root, 'memory-cleanup.json')
    let records: string[]
    try {
      await this.safePath('memory-cleanup.json')
      const journal = JSON.parse(await fs.readFile(file, 'utf8'))
      if (journal.version !== 1 || !Array.isArray(journal.records) || journal.records.some((item: unknown) => typeof item !== 'string' || !this.managedRecord(item))) throw new AgentMemoryError('清理日志损坏，请检查本机文件；未继续写入记忆。')
      records = journal.records
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    generations.set(path.resolve(this.root), this.generation + 1)
    let changed = false
    try {
      for (const relative of records) {
        try { await this.safePath(relative); await fs.unlink(path.join(this.root, relative)); changed = true }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await this.syncDirectory(path.dirname(path.join(this.root, relative)))
      }
      await fs.unlink(file)
      changed = true
      await this.syncDirectory(this.root)
    } finally { if (changed) this.invalidate({ kind: 'user' }) }
  }
  private async atomicWrite(file: string, content: string, onRenamed?: () => void) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporary, 'wx', 0o600)
      try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
      await (this.io.rename ?? fs.rename)(temporary, file)
      onRenamed?.()
      await this.syncDirectory(path.dirname(file))
    } finally { await fs.rm(temporary, { force: true }) }
  }
  private async syncDirectory(directoryPath: string) {
    if (this.io.syncDirectory) await this.io.syncDirectory(directoryPath)
    else if (process.platform !== 'win32') {
      const directory = await fs.open(directoryPath, 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  }
}
