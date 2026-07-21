import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { FilePatchArtifact } from '../../../shared/types/agent-events'
import type { AgentArtifactEnvelope } from './agentLedgerTypes'

const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/

export const sha256Text = (content: string) => `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`

const safeRelativePath = (value: string) => {
  const normalized = value.trim().replace(/\\+/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('Patch path must be workspace-relative')
  }
  const segments = normalized.split('/').filter(Boolean)
  if (!segments.length || segments.some(segment => segment === '.' || segment === '..' || segment.includes(':') || segment.toLowerCase() === '.looma')) {
    throw new Error('Patch path contains a protected or invalid segment')
  }
  return segments.join('/')
}

const isInside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const exists = async (filePath: string) => {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const ensureSafeTarget = async (workspaceRoot: string, relativePath: string) => {
  const safePath = safeRelativePath(relativePath)
  const rootReal = await realpath(workspaceRoot)
  const segments = safePath.split('/')
  let cursor = rootReal
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment)
    if (!await exists(cursor)) continue
    const stat = await lstat(cursor)
    if (stat.isSymbolicLink()) throw new Error('Patch path traverses a symbolic link')
    const componentReal = await realpath(cursor)
    if (!isInside(rootReal, componentReal)) throw new Error('Patch path escapes workspace')
  }
  const target = path.join(rootReal, ...segments)
  if (!isInside(rootReal, target)) throw new Error('Patch path escapes workspace')
  if (await exists(target)) {
    const stat = await lstat(target)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Patch target must be a regular file')
    const targetReal = await realpath(target)
    if (!isInside(rootReal, targetReal)) throw new Error('Patch target escapes workspace')
  }
  return { target, safePath }
}

const readCurrent = async (target: string) => {
  try {
    return await readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const durableCreate = async (filePath: string, content: string) => {
  const handle = await open(filePath, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export type ApplyArtifactResult =
  | { status: 'applied'; path: string; beforeHash: string | null; afterHash: string }
  | { status: 'already_applied'; path: string; beforeHash: string | null; afterHash: string }
  | { status: 'conflict'; path: string; expectedHash: string | null; actualHash: string | null }

export class AgentArtifactStore {
  private readonly artifactDir: string
  private readonly temporaryDir: string

  constructor(private readonly rootDir: string) {
    this.artifactDir = path.join(rootDir, 'artifacts')
    this.temporaryDir = path.join(rootDir, 'tmp')
  }

  async init() {
    await Promise.all([
      mkdir(this.artifactDir, { recursive: true }),
      mkdir(this.temporaryDir, { recursive: true }),
    ])
  }

  private artifactPath(artifactId: string) {
    if (!SAFE_ID.test(artifactId)) throw new Error('Invalid artifact id')
    return path.join(this.artifactDir, `${artifactId}.json`)
  }

  async save(artifact: FilePatchArtifact) {
    await this.init()
    if (Buffer.byteLength(artifact.proposedContent, 'utf8') > MAX_ARTIFACT_BYTES) throw new Error('Patch artifact is too large')
    if (sha256Text(artifact.proposedContent) !== artifact.afterHash) throw new Error('Patch artifact afterHash mismatch')
    safeRelativePath(artifact.path)
    const envelope: AgentArtifactEnvelope = { schemaVersion: 1, artifact }
    const temporaryPath = path.join(this.temporaryDir, `${artifact.artifactId}-${randomUUID()}.tmp`)
    await durableCreate(temporaryPath, JSON.stringify(envelope))
    try {
      await rename(temporaryPath, this.artifactPath(artifact.artifactId))
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }

  async load(artifactId: string) {
    const content = await readFile(this.artifactPath(artifactId), 'utf8')
    if (Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_BYTES + 64 * 1024) throw new Error('Patch artifact is too large')
    const parsed = JSON.parse(content) as AgentArtifactEnvelope
    if (parsed.schemaVersion !== 1 || parsed.artifact.artifactId !== artifactId) throw new Error('Invalid patch artifact')
    if (sha256Text(parsed.artifact.proposedContent) !== parsed.artifact.afterHash) throw new Error('Patch artifact hash mismatch')
    return parsed.artifact
  }

  async apply(workspaceRoot: string, workspaceId: string, artifactId: string): Promise<ApplyArtifactResult> {
    const artifact = await this.load(artifactId)
    if (artifact.workspaceId !== workspaceId) throw new Error('Patch artifact belongs to another workspace')
    if (artifact.expiresAt <= Date.now()) throw new Error('Patch approval has expired')
    const { target, safePath } = await ensureSafeTarget(workspaceRoot, artifact.path)
    const currentContent = await readCurrent(target)
    const actualHash = currentContent === null ? null : sha256Text(currentContent)
    if (actualHash === artifact.afterHash) {
      return { status: 'already_applied', path: safePath, beforeHash: artifact.beforeHash, afterHash: artifact.afterHash }
    }
    if (actualHash !== artifact.beforeHash) {
      return { status: 'conflict', path: safePath, expectedHash: artifact.beforeHash, actualHash }
    }

    await mkdir(path.dirname(target), { recursive: true })
    const parentReal = await realpath(path.dirname(target))
    const rootReal = await realpath(workspaceRoot)
    if (!isInside(rootReal, parentReal)) throw new Error('Patch parent escapes workspace')
    const temporaryPath = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.looma-tmp`)
    await durableCreate(temporaryPath, artifact.proposedContent)
    try {
      if (process.platform === 'win32' && await exists(target)) {
        const backupPath = `${target}.${randomUUID()}.looma-backup`
        await rename(target, backupPath)
        try {
          await rename(temporaryPath, target)
          await rm(backupPath, { force: true })
        } catch (error) {
          if (!await exists(target)) await rename(backupPath, target)
          throw error
        }
      } else {
        await rename(temporaryPath, target)
      }
    } finally {
      await rm(temporaryPath, { force: true })
    }
    const written = await readFile(target, 'utf8')
    if (sha256Text(written) !== artifact.afterHash) throw new Error('Patch verification failed after write')
    return { status: 'applied', path: safePath, beforeHash: artifact.beforeHash, afterHash: artifact.afterHash }
  }
}
