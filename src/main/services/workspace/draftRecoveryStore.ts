import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'

const SCHEMA_VERSION = 1 as const
const MAX_DRAFT_BYTES = 64 * 1024 * 1024

export interface SaveDraftInput {
  workspaceId: string
  relativePath: string
  draftContent: string
  baseContent: string
  revision: string
}

export interface DraftRecoveryRecord {
  schemaVersion: typeof SCHEMA_VERSION
  workspaceId: string
  relativePath: string
  draftContent: string
  baseContentHash: string
  revision: string
  updatedAt: number
}

export type DraftRecoveryResult =
  | { status: 'none' }
  | { status: 'restorable' | 'conflict'; draft: DraftRecoveryRecord }

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

const normalizeRelativePath = (value: string) => {
  const normalized = value.trim().replace(/\\+/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('Draft path must be workspace-relative')
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Draft path contains an invalid segment')
  }
  return segments.join('/')
}

const isSameOrChildPath = (parent: string, candidate: string) => candidate === parent || candidate.startsWith(`${parent}/`)

const remapPath = (relativePath: string, items: { from: string; to: string }[]) => {
  for (const item of items) {
    if (!isSameOrChildPath(item.from, relativePath)) continue
    return item.to + relativePath.slice(item.from.length)
  }
  return relativePath
}

const isRecord = (value: unknown): value is DraftRecoveryRecord => {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<DraftRecoveryRecord>
  return record.schemaVersion === SCHEMA_VERSION
    && typeof record.workspaceId === 'string'
    && typeof record.relativePath === 'string'
    && typeof record.draftContent === 'string'
    && typeof record.baseContentHash === 'string'
    && typeof record.revision === 'string'
    && typeof record.updatedAt === 'number'
}

const writeDurableFile = async (filePath: string, content: string) => {
  const handle = await open(filePath, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const syncDirectory = async (directory: string) => {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Windows does not support opening directories for fsync. The immutable
    // commit remains atomic there; POSIX filesystems take the durable path.
    if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM', 'EACCES'].includes(code || '')) throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

export class DraftRecoveryStore {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly rootDir: string) {}

  private recordPath(workspaceId: string, relativePath: string) {
    const normalizedPath = normalizeRelativePath(relativePath)
    const workspaceDirectory = sha256(workspaceId)
    const pathHash = sha256(normalizedPath)
    const directory = path.join(this.rootDir, workspaceDirectory)
    return {
      normalizedPath,
      directory,
      pathHash,
      filePrefix: `${pathHash}.`,
    }
  }

  private async candidatePaths(target: ReturnType<DraftRecoveryStore['recordPath']>) {
    try {
      const names = await readdir(target.directory)
      return names
        .filter((name) => name === `${target.pathHash}.json` || (name.startsWith(target.filePrefix) && name.endsWith('.json')))
        .map((name) => path.join(target.directory, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async readRecords(target: ReturnType<DraftRecoveryStore['recordPath']>, workspaceId: string) {
    const records: Array<{ filePath: string; record: DraftRecoveryRecord }> = []
    for (const filePath of await this.candidatePaths(target)) {
      try {
        const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
        if (isRecord(parsed) && parsed.workspaceId === workspaceId && parsed.relativePath === target.normalizedPath) {
          records.push({ filePath, record: parsed })
        }
      } catch {}
    }
    return records.sort((a, b) => b.record.updatedAt - a.record.updatedAt)
  }

  private async readLatestWorkspaceRecords(workspaceId: string) {
    const directory = path.join(this.rootDir, sha256(workspaceId))
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const latestByPath = new Map<string, DraftRecoveryRecord>()
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      try {
        const parsed: unknown = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
        if (!isRecord(parsed) || parsed.workspaceId !== workspaceId) continue
        const existing = latestByPath.get(parsed.relativePath)
        if (!existing || parsed.updatedAt > existing.updatedAt) latestByPath.set(parsed.relativePath, parsed)
      } catch {}
    }
    return Array.from(latestByPath.values())
  }

  private async serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const chain = previous.catch(() => {}).then(() => current)
    this.queues.set(key, chain)
    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.queues.get(key) === chain) this.queues.delete(key)
    }
  }

  private async ensureDurableDirectory(directory: string) {
    const rootCreated = await mkdir(this.rootDir, { recursive: true })
    if (rootCreated) await syncDirectory(path.dirname(this.rootDir))
    let directoryCreated = false
    try {
      await mkdir(directory)
      directoryCreated = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (directoryCreated) await syncDirectory(this.rootDir)
  }

  private async removeFiles(filePaths: string[]) {
    for (const filePath of filePaths) {
      try {
        await rm(filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  private async commitRecord(
    target: ReturnType<DraftRecoveryStore['recordPath']>,
    workspaceId: string,
    record: DraftRecoveryRecord,
  ) {
    await this.ensureDurableDirectory(target.directory)
    const previousUpdatedAt = (await this.readRecords(target, workspaceId))[0]?.record.updatedAt ?? 0
    const committedRecord = { ...record, updatedAt: Math.max(Date.now(), previousUpdatedAt + 1) }
    const commitId = randomUUID()
    const temporaryPath = path.join(target.directory, `${target.filePrefix}${commitId}.tmp`)
    const committedPath = path.join(target.directory, `${target.filePrefix}${commitId}.json`)
    await writeDurableFile(temporaryPath, JSON.stringify(committedRecord))
    try {
      // This destination is always new, making the visible commit atomic on
      // Windows and POSIX while the previous record remains recoverable.
      await rename(temporaryPath, committedPath)
      await syncDirectory(target.directory)
    } finally {
      await rm(temporaryPath, { force: true })
    }
    const obsoletePaths = (await this.candidatePaths(target)).filter((filePath) => filePath !== committedPath)
    await this.removeFiles(obsoletePaths)
    await syncDirectory(target.directory)
    return committedRecord
  }

  private async removeTargetRecords(target: ReturnType<DraftRecoveryStore['recordPath']>) {
    const candidates = await this.candidatePaths(target)
    await this.removeFiles(candidates)
    if (candidates.length > 0) await syncDirectory(target.directory)
    return candidates.length > 0
  }

  async save(input: SaveDraftInput): Promise<DraftRecoveryRecord> {
    if (!input.workspaceId.trim() || !input.revision.trim()) throw new Error('Draft identity is required')
    if (Buffer.byteLength(input.draftContent, 'utf8') > MAX_DRAFT_BYTES) throw new Error('Draft is too large')
    const target = this.recordPath(input.workspaceId, input.relativePath)
    return this.serialized(target.directory, () => this.commitRecord(target, input.workspaceId, {
      schemaVersion: SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      relativePath: target.normalizedPath,
      draftContent: input.draftContent,
      baseContentHash: sha256(input.baseContent),
      revision: input.revision,
      updatedAt: Date.now(),
    }))
  }

  async get(workspaceId: string, relativePath: string, diskContent: string): Promise<DraftRecoveryResult> {
    const target = this.recordPath(workspaceId, relativePath)
    return this.serialized(target.directory, async () => {
      const latest = (await this.readRecords(target, workspaceId))[0]?.record
      if (!latest) return { status: 'none' }
      if (latest.draftContent === diskContent) {
        await this.removeTargetRecords(target)
        return { status: 'none' }
      }
      return {
        status: latest.baseContentHash === sha256(diskContent) ? 'restorable' : 'conflict',
        draft: latest,
      }
    })
  }

  async remove(workspaceId: string, relativePath: string, expectedRevision?: string): Promise<boolean> {
    const target = this.recordPath(workspaceId, relativePath)
    return this.serialized(target.directory, async () => {
      const latest = (await this.readRecords(target, workspaceId))[0]?.record
      if (!latest || (expectedRevision && latest.revision !== expectedRevision)) return false
      return this.removeTargetRecords(target)
    })
  }

  async move(workspaceId: string, fromRelativePath: string, toRelativePath: string, expectedRevision: string): Promise<boolean> {
    const source = this.recordPath(workspaceId, fromRelativePath)
    const destination = this.recordPath(workspaceId, toRelativePath)
    if (source.normalizedPath === destination.normalizedPath) return true
    return this.serialized(source.directory, async () => {
      const latest = (await this.readRecords(source, workspaceId))[0]?.record
      if (!latest || latest.revision !== expectedRevision) return false
      await this.commitRecord(destination, workspaceId, {
        ...latest,
        relativePath: destination.normalizedPath,
      })
      await this.removeTargetRecords(source)
      return true
    })
  }

  async movePaths(workspaceId: string, rawItems: { from: string; to: string }[]): Promise<number> {
    const items = rawItems.map((item) => ({
      from: normalizeRelativePath(item.from),
      to: normalizeRelativePath(item.to),
    }))
    const workspaceKey = path.join(this.rootDir, sha256(workspaceId))
    return this.serialized(workspaceKey, async () => {
      let moved = 0
      for (const record of await this.readLatestWorkspaceRecords(workspaceId)) {
        const nextPath = remapPath(record.relativePath, items)
        if (nextPath === record.relativePath) continue
        const source = this.recordPath(workspaceId, record.relativePath)
        const destination = this.recordPath(workspaceId, nextPath)
        await this.commitRecord(destination, workspaceId, { ...record, relativePath: destination.normalizedPath })
        await this.removeTargetRecords(source)
        moved += 1
      }
      return moved
    })
  }

  async removePaths(workspaceId: string, rawPaths: string[]): Promise<number> {
    const targets = rawPaths.map(normalizeRelativePath)
    const workspaceKey = path.join(this.rootDir, sha256(workspaceId))
    return this.serialized(workspaceKey, async () => {
      let removed = 0
      for (const record of await this.readLatestWorkspaceRecords(workspaceId)) {
        if (!targets.some((target) => isSameOrChildPath(target, record.relativePath))) continue
        if (await this.removeTargetRecords(this.recordPath(workspaceId, record.relativePath))) removed += 1
      }
      return removed
    })
  }
}
