import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { MAX_MEMORY_CHARS, type AgentMemoryKind, type AgentMemoryDocument, type AgentMemorySnapshot } from '../../../shared/types/agent-memory'

const revision = (content: string) => createHash('sha256').update(content).digest('hex')
const queues = new Map<string, Promise<unknown>>()
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
    return this.locked(async () => {
      const current = await this.read(kind)
      // Recheck inside the shared queue, after the asynchronous CAS read. From
      // here the atomic save has started; later revocation cannot roll it back.
      if (authorize && !authorize()) throw new AgentMemoryAuthorizationError('自动维护用户画像已关闭或运行授权已失效。')
      if (current.revision !== expectedRevision) throw new AgentMemoryConflictError('内容已在其他窗口更新，请重新加载后再保存。')
      validateContent(content)
      await this.atomicWrite(this.file(kind), content)
      return { content, revision: revision(content) }
    })
  }
  private async atomicWrite(file: string, content: string) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporary, 'wx', 0o600)
      try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
      await (this.io.rename ?? fs.rename)(temporary, file)
      if (this.io.syncDirectory) await this.io.syncDirectory(path.dirname(file))
      else if (process.platform !== 'win32') {
        const directory = await fs.open(path.dirname(file), 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
    } finally { await fs.rm(temporary, { force: true }) }
  }
}
