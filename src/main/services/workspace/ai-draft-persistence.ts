import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'

type DraftState = { conversations: { id: string; draft: string }[] }
type Drafts = { revision: string | null; values: Record<string, string> }

// A checkpoint revision makes an old sidecar harmless even if the process exits
// immediately after replacing state.json. Failed writes never advance the cache.
export class AiDraftPersistence {
  private queues = new Map<string, Promise<unknown>>()
  private drafts = new Map<string, Drafts>()
  private conversationIds = new Map<string, Set<string>>()

  private enqueue<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(file) ?? Promise.resolve()).catch(() => {}).then(operation).catch(error => {
      // A rename may have succeeded before a later sync/cleanup failed. Reload
      // from disk next time rather than associating new drafts with an old revision.
      this.drafts.delete(file)
      this.conversationIds.delete(file)
      throw error
    })
    this.queues.set(file, pending)
    void pending.finally(() => {
      if (this.queues.get(file) === pending) this.queues.delete(file)
    }).catch(() => {})
    return pending
  }

  private async atomicWrite(file: string, value: unknown) {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(value), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temporary, file)
      // Node cannot open/sync directory handles on Windows.
      if (process.platform !== 'win32') {
        const directory = await fs.open(path.dirname(file), 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
    } finally {
      await fs.unlink(temporary).catch(() => {})
    }
  }

  private async readDrafts(file: string, revision: string | null): Promise<Drafts> {
    try {
      const stored = JSON.parse(await fs.readFile(`${file}.drafts`, 'utf8'))
      if (stored && stored.revision === revision && stored.values && typeof stored.values === 'object'
        && !Array.isArray(stored.values) && Object.values(stored.values).every(value => typeof value === 'string')) return stored
    } catch (error: any) {
      // A damaged sidecar must never turn a healthy checkpoint into default state.
      // Leave it untouched for recovery; actual I/O failures still propagate.
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    return { revision, values: {} }
  }

  get<T extends DraftState = DraftState>(file: string): Promise<T> {
    return this.enqueue(file, async () => {
      const state = JSON.parse(await fs.readFile(file, 'utf8'))
      const drafts = await this.readDrafts(file, state.draftRevision ?? null)
      for (const conversation of state.conversations ?? []) {
        if (Object.prototype.hasOwnProperty.call(drafts.values, conversation.id) && typeof drafts.values[conversation.id] === 'string') {
          conversation.draft = drafts.values[conversation.id]
        }
      }
      this.drafts.set(file, drafts)
      this.conversationIds.set(file, new Set((state.conversations ?? []).map((item: { id: string }) => item.id)))
      return state
    })
  }

  set<T extends DraftState>(file: string, state: T): Promise<void> {
    return this.enqueue(file, async () => {
      const revision = randomUUID()
      await this.atomicWrite(file, { ...state, draftRevision: revision })
      this.drafts.set(file, { revision, values: {} })
      this.conversationIds.set(file, new Set(state.conversations.map(item => item.id)))
      await fs.unlink(`${file}.drafts`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    })
  }

  setDraft(file: string, conversationId: string, draft: string): Promise<void> {
    return this.enqueue(file, async () => {
      let previous = this.drafts.get(file)
      if (!previous) {
        const state = JSON.parse(await fs.readFile(file, 'utf8'))
        previous = await this.readDrafts(file, state.draftRevision ?? null)
        this.conversationIds.set(file, new Set((state.conversations ?? []).map((item: { id: string }) => item.id)))
      }
      if (!this.conversationIds.get(file)?.has(conversationId)) throw new Error('对话不存在，无法保存草稿')
      const next = { revision: previous.revision, values: { ...previous.values, [conversationId]: draft } }
      await this.atomicWrite(`${file}.drafts`, next)
      this.drafts.set(file, next)
    })
  }
}
