import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  shell: { showItemInFolder: vi.fn() },
}))

import { applyAgentFileProposal, type AgentFileProposal } from '../fileSystemService'

const hash = (value: string) => createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')
const proposal = (overrides: Partial<AgentFileProposal> = {}): AgentFileProposal => {
  const content = overrides.proposed_content ?? 'new content\n'
  return {
    path: 'notes/a.md',
    operation: 'create',
    unified_diff: '--- /dev/null\n+++ notes/a.md\n+new content',
    expected_sha256: null,
    proposed_sha256: hash(content),
    proposed_content: content,
    ...overrides,
  }
}

describe('applyAgentFileProposal', () => {
  let workspace = ''

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-agent-patch-'))
    await fs.mkdir(path.join(workspace, 'notes'))
  })

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true })
  })

  it('creates an approved UTF-8 file and verifies the result hash', async () => {
    const result = await applyAgentFileProposal(workspace, proposal())
    expect(result.success).toBe(true)
    expect(await fs.readFile(path.join(workspace, 'notes/a.md'), 'utf8')).toBe('new content\n')
    expect(result.data?.sha256).toBe(hash('new content\n'))
  })

  it('updates only when the current byte hash still matches', async () => {
    const target = path.join(workspace, 'notes/a.md')
    await fs.writeFile(target, 'old\n')
    const result = await applyAgentFileProposal(workspace, proposal({
      operation: 'update',
      expected_sha256: hash('old\n'),
    }))
    expect(result.success).toBe(true)
    expect(await fs.readFile(target, 'utf8')).toBe('new content\n')
  })

  it('rejects a stale hash without changing the file', async () => {
    const target = path.join(workspace, 'notes/a.md')
    await fs.writeFile(target, 'changed\n')
    const result = await applyAgentFileProposal(workspace, proposal({
      operation: 'update',
      expected_sha256: hash('old\n'),
    }))
    expect(result.success).toBe(false)
    expect(await fs.readFile(target, 'utf8')).toBe('changed\n')
  })

  it.each(['../outside.md', '.looma/secret', 'notes/a.md:stream', 'notes/CON', 'C:/outside.md'])('rejects unsafe path %s', async (unsafePath) => {
    const result = await applyAgentFileProposal(workspace, proposal({ path: unsafePath }))
    expect(result.success).toBe(false)
  })

  it('rejects proposal content tampering', async () => {
    const result = await applyAgentFileProposal(workspace, proposal({ proposed_sha256: hash('different') }))
    expect(result.success).toBe(false)
    await expect(fs.stat(path.join(workspace, 'notes/a.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a symlink target when the platform permits links', async () => {
    const outside = path.join(workspace, 'outside.md')
    await fs.writeFile(outside, 'outside\n')
    try {
      await fs.symlink(outside, path.join(workspace, 'notes/link.md'))
    } catch {
      return
    }
    const result = await applyAgentFileProposal(workspace, proposal({ path: 'notes/link.md' }))
    expect(result.success).toBe(false)
    expect(await fs.readFile(outside, 'utf8')).toBe('outside\n')
  })
})
