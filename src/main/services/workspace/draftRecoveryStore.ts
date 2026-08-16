import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
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

const atomicReplace = async (temporaryPath: string, targetPath: string) => {
  try {
    await rename(temporaryPath, targetPath)
    return
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error
  }

  // Windows cannot atomically rename over an existing file. Keep the previous
  // record until the replacement is committed, and roll it back on failure.
  const backupPath = `${targetPath}.${randomUUID()}.bak`
  let movedExisting = false
  try {
    try {
      await rename(targetPath, backupPath)
      movedExisting = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(temporaryPath, targetPath)
    if (movedExisting) await rm(backupPath, { force: true })
  } catch (error) {
    if (movedExisting) {
      try { await rename(backupPath, targetPath) } catch {}
    }
    throw error
  }
}

export class DraftRecoveryStore {
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly rootDir: string) {}

  private recordPath(workspaceId: string, relativePath: string) {
    const normalizedPath = normalizeRelativePath(relativePath)
    const workspaceDirectory = sha256(workspaceId)
    return {
      normalizedPath,
      directory: path.join(this.rootDir, workspaceDirectory),
      filePath: path.join(this.rootDir, workspaceDirectory, `${sha256(normalizedPath)}.json`),
    }
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

  async save(input: SaveDraftInput): Promise<DraftRecoveryRecord> {
    if (!input.workspaceId.trim() || !input.revision.trim()) throw new Error('Draft identity is required')
    if (Buffer.byteLength(input.draftContent, 'utf8') > MAX_DRAFT_BYTES) throw new Error('Draft is too large')
    const target = this.recordPath(input.workspaceId, input.relativePath)
    return this.serialized(target.filePath, async () => {
      await mkdir(target.directory, { recursive: true })
      const record: DraftRecoveryRecord = {
        schemaVersion: SCHEMA_VERSION,
        workspaceId: input.workspaceId,
        relativePath: target.normalizedPath,
        draftContent: input.draftContent,
        baseContentHash: sha256(input.baseContent),
        revision: input.revision,
        updatedAt: Date.now(),
      }
      const temporaryPath = path.join(target.directory, `${path.basename(target.filePath)}.${randomUUID()}.tmp`)
      await writeDurableFile(temporaryPath, JSON.stringify(record))
      try {
        await atomicReplace(temporaryPath, target.filePath)
      } finally {
        await rm(temporaryPath, { force: true })
      }
      return record
    })
  }

  async get(workspaceId: string, relativePath: string, diskContent: string): Promise<DraftRecoveryResult> {
    const target = this.recordPath(workspaceId, relativePath)
    return this.serialized(target.filePath, async () => {
      try {
        const parsed: unknown = JSON.parse(await readFile(target.filePath, 'utf8'))
        if (!isRecord(parsed)) return { status: 'none' }
        if (parsed.workspaceId !== workspaceId || parsed.relativePath !== target.normalizedPath) return { status: 'none' }
        if (parsed.draftContent === diskContent) {
          await rm(target.filePath, { force: true })
          return { status: 'none' }
        }
        return {
          status: parsed.baseContentHash === sha256(diskContent) ? 'restorable' : 'conflict',
          draft: parsed,
        }
      } catch {
        return { status: 'none' }
      }
    })
  }

  async remove(workspaceId: string, relativePath: string, expectedRevision?: string): Promise<boolean> {
    const target = this.recordPath(workspaceId, relativePath)
    return this.serialized(target.filePath, async () => {
      if (expectedRevision) {
        try {
          const parsed: unknown = JSON.parse(await readFile(target.filePath, 'utf8'))
          if (!isRecord(parsed) || parsed.revision !== expectedRevision) return false
        } catch {
          return false
        }
      }
      try {
        await rm(target.filePath)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    })
  }
}
