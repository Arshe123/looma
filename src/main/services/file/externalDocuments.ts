import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileService } from './fileService'

export type ExternalDocument = { id: string; filePath: string; content: string; baseContent: string }
type OpenDocument = { filePath: string; owner: number }
export class ExternalDocuments {
  private documents = new Map<string, OpenDocument>()
  constructor(readonly recoveryDirectory: string) {}

  async open(filePath: string, owner: number): Promise<ExternalDocument> {
    if (!path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.md') throw new Error('仅支持 Markdown (.md) 文件')
    const canonical = await fs.realpath(filePath)
    if (!(await fs.stat(canonical)).isFile()) throw new Error('不是文件')
    const id = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex')
    const existing = this.documents.get(id)
    if (existing && existing.owner !== owner) throw new Error('文件已在其他窗口打开')
    this.documents.set(id, { filePath: canonical, owner })
    const content = await fs.readFile(canonical, 'utf8')
    const recovered = await this.serial(async () => (await this.records()).find(record => record.data.id === id)?.data)
    if (recovered && recovered.content !== content) return { ...recovered, filePath: canonical }
    return { id, filePath: canonical, content, baseContent: content }
  }

  private queue: Promise<unknown> = Promise.resolve()
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }
  private async records() {
    const records: { name: string; data: ExternalDocument & { updatedAt: number } }[] = []
    for (const name of await fs.readdir(this.recoveryDirectory).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue
      try {
        const data = JSON.parse(await fs.readFile(path.join(this.recoveryDirectory, name), 'utf8'))
        if (typeof data.id === 'string' && /^[a-f0-9]{64}$/.test(data.id)
          && typeof data.filePath === 'string' && path.isAbsolute(data.filePath)
          && typeof data.content === 'string' && typeof data.baseContent === 'string'
          && Number.isFinite(data.updatedAt)) records.push({ name, data })
      } catch { /* Incomplete/corrupt commits are not recovery candidates. */ }
    }
    return records.sort((a, b) => b.data.updatedAt - a.data.updatedAt)
  }
  private async syncDirectory() {
    if (process.platform === 'win32') return
    const handle = await fs.open(this.recoveryDirectory, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }
  private async removeDraft(id: string) {
    const records = await this.records()
    for (const record of records.filter(record => record.data.id === id)) {
      await fs.rm(path.join(this.recoveryDirectory, record.name), { force: true })
    }
    if (records.length) await this.syncDirectory()
  }
  recoveryPaths() {
    return this.serial(async () => [...new Set((await this.records()).map(record => record.data.filePath))])
  }
  draft(id: string, owner: number, content: string, baseContent: string) {
    return this.serial(async () => {
      const document = this.authorized(id, owner)
      if (typeof content !== 'string' || typeof baseContent !== 'string' || Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error('恢复草稿过大或格式无效')
      if (content === baseContent) return this.removeDraft(id)
      await fs.mkdir(this.recoveryDirectory, { recursive: true })
      const old = (await this.records()).filter(record => record.data.id === id)
      const updatedAt = Math.max(Date.now(), (old[0]?.data.updatedAt || 0) + 1)
      const target = path.join(this.recoveryDirectory, `${id}-${randomUUID()}.json`)
      const temporary = `${target}.tmp`
      const handle = await fs.open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ id, filePath: document.filePath, content, baseContent, updatedAt }))
        await handle.sync()
      } finally { await handle.close() }
      await fs.rename(temporary, target)
      await this.syncDirectory()
      await Promise.all(old.map(record => fs.rm(path.join(this.recoveryDirectory, record.name), { force: true })))
      await this.syncDirectory()
    })
  }
  close(id: string, owner: number) {
    return this.serial(async () => {
      this.authorized(id, owner)
      await this.removeDraft(id)
      this.documents.delete(id)
    })
  }
  releaseOwner(owner: number) {
    for (const [id, doc] of this.documents) if (doc.owner === owner) this.documents.delete(id)
  }
  ownerFor(filePath: string) {
    return [...this.documents.values()].find(doc => doc.filePath === filePath)?.owner
  }

  private authorized(id: string, owner: number) {
    const document = this.documents.get(id)
    if (!document || document.owner !== owner) throw new Error('文件未授权给此窗口')
    return document
  }

  readCurrent(id: string, owner: number) {
    return fs.readFile(this.authorized(id, owner).filePath, 'utf8')
  }

  async save(id: string, owner: number, content: string, expectedContent: string) {
    if (typeof content !== 'string' || typeof expectedContent !== 'string') throw new Error('保存内容和磁盘基线必须为文本')
    const document = this.authorized(id, owner)
    if (await fs.realpath(document.filePath) !== document.filePath) throw new Error('文件路径已改变')
    const result = await fileService.writeMarkdown(document.filePath, content, expectedContent, { allowEmptyContent: true })
    if (!result.success) throw new Error(result.error)
  }
}
