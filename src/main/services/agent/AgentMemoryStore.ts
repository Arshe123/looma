import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { MAX_MEMORY_CHARS, type AgentMemoryKind, type AgentMemoryDocument, type AgentMemorySnapshot, type UserProfileHistoryEntry, type UserProfileHistoryPage } from '../../../shared/types/agent-memory'

const revision = (content: string) => createHash('sha256').update(content).digest('hex')
const queues = new Map<string, Promise<unknown>>()
const historyId = /^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
export class AgentMemoryError extends Error {}
export class AgentMemoryConflictError extends AgentMemoryError {}
export class AgentMemoryAuthorizationError extends AgentMemoryError {}
function validateContent(content: unknown): asserts content is string {
  if (typeof content !== 'string' || content.length > MAX_MEMORY_CHARS || content.includes('\0')) throw new AgentMemoryError('记忆内容无效或过长。')
}
export class AgentMemoryStore {
  constructor(private readonly root: string, private readonly io: { rename?: typeof fs.rename; syncDirectory?: (directory: string) => Promise<void> } = {}) {}
  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.root)
    const next = (queues.get(key) ?? Promise.resolve()).then(operation, operation)
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
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(this.file(kind))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      content = ''
    }
    validateContent(content)
    return { content, revision: revision(content) }
  }
  async save(kind: AgentMemoryKind, content: string, expectedRevision: string, authorize?: () => boolean): Promise<AgentMemoryDocument> {
    return this.locked(() => this.saveLocked(kind, content, expectedRevision, authorize ? 'agent' : 'manual', authorize))
  }
  private async saveLocked(kind: AgentMemoryKind, content: string, expectedRevision: string, source: UserProfileHistoryEntry['source'], authorize?: () => boolean): Promise<AgentMemoryDocument> {
      const current = await this.read(kind)
      if (authorize && !authorize()) throw new AgentMemoryAuthorizationError('自动维护用户画像已关闭或运行授权已失效。')
      if (current.revision !== expectedRevision) throw new AgentMemoryConflictError('内容已在其他窗口更新，请重新加载后再保存。')
      validateContent(content)
      if (kind === 'user') {
        if (content === current.content) return current
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
      await this.atomicWrite(this.file(kind), content)
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
    try {
      await this.validateHistoryDirectory()
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.size > MAX_MEMORY_CHARS * 6 + 1024) throw new Error('invalid file')
      const entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file))) as UserProfileHistoryEntry
      validateContent(entry?.content)
      if (entry.id !== id || entry.revision !== revision(entry.content) || entry.createdAt !== Number(id.slice(0, 13))
        || !['manual', 'agent', 'restore'].includes(entry.source)) throw new Error('invalid entry')
      return { id, createdAt: entry.createdAt, source: entry.source, revision: entry.revision, content: entry.content }
    } catch { throw new AgentMemoryError('历史版本缺失或已损坏，未恢复任何内容。') }
  }
  async listUserHistory(cursor?: string): Promise<UserProfileHistoryPage> {
    if (cursor !== undefined) this.historyFile(cursor)
    return this.locked(async () => {
      const ids = (await this.historyIds()).filter(id => cursor === undefined || id < cursor)
      const entries = await Promise.all(ids.slice(0, 20).map(async id => {
        const { content: _content, ...entry } = await this.readUserHistory(id)
        return entry
      }))
      return { entries, ...(ids.length > 20 ? { nextCursor: ids[19] } : {}) }
    })
  }
  async restoreUserHistory(id: string, expectedRevision: string): Promise<AgentMemoryDocument> {
    return this.locked(async () => {
      const entry = await this.readUserHistory(id)
      return this.saveLocked('user', entry.content, expectedRevision, 'restore')
    })
  }
  private async atomicWrite(file: string, content: string) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporary, 'wx', 0o600)
      try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
      await (this.io.rename ?? fs.rename)(temporary, file)
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
