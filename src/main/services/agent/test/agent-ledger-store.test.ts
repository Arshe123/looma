import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent, FilePatchArtifact } from '../../../../shared/types/agent-events'
import type { AgentMessage } from '../../../../shared/types/agent-message'
import { AgentArtifactStore, sha256Text } from '../AgentArtifactStore'
import { AgentLedgerStore } from '../AgentLedgerStore'

const roots: string[] = []
const createRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'looma-agent-ledger-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const toolCallEvent: AgentEvent = {
  id: 'evt_1', sequence: 1, taskId: 'task_1', runId: 'run_1', timestamp: 10,
  family: 'execution', type: 'tool_call_requested',
  payload: { stepId: 'step_1', callId: 'call_1', tool: 'file_read', argumentsPreview: { path: 'notes/a.md' }, argumentsDigest: 'digest_1', startedAt: 10 },
}
const assistantToolMessage: AgentMessage = {
  id: 'msg_1', conversationId: 'chat_1', taskId: 'task_1', runId: 'run_1', role: 'assistant', content: null, createdAt: 10,
  tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'file_read', arguments: { path: 'notes/a.md' } } }],
}
const toolResultEvent: AgentEvent = {
  id: 'evt_2', sequence: 2, taskId: 'task_1', runId: 'run_1', timestamp: 20,
  family: 'execution', type: 'tool_result_recorded',
  payload: { stepId: 'step_1', callId: 'call_1', tool: 'file_read', status: 'completed', durationMs: 10, uiSummary: '已读取文件', modelContext: { facts: ['文件存在'], structuredData: { path: 'notes/a.md' } } },
}
const toolMessage: AgentMessage = {
  id: 'msg_2', conversationId: 'chat_1', taskId: 'task_1', runId: 'run_1', role: 'tool', name: 'file_read', tool_call_id: 'call_1', content: '{"facts":["文件存在"],"structuredData":{"path":"notes/a.md"}}', createdAt: 20,
}

describe('AgentLedgerStore', () => {
  it('commits event, message and outbox in one immutable transaction', async () => {
    const store = new AgentLedgerStore(await createRoot())
    await store.commitToolCall(toolCallEvent, assistantToolMessage, { callId: 'call_1', taskId: 'task_1', runId: 'run_1', tool: 'file_read', status: 'pending', updatedAt: 10 })
    await store.commitToolResult(toolResultEvent, toolMessage, { callId: 'call_1', taskId: 'task_1', runId: 'run_1', tool: 'file_read', status: 'completed', updatedAt: 20, resultEventId: 'evt_2' })

    const view = await store.materialize()
    expect(view.events.map(event => event.type)).toEqual(['tool_call_requested', 'tool_result_recorded'])
    expect(view.messages.map(message => message.role)).toEqual(['assistant', 'tool'])
    expect(view.outbox.call_1.status).toBe('completed')
    expect(await store.audit()).toEqual([])
    expect((await store.readTransactions()).map(tx => tx.kind)).toEqual(['tool_call_commit', 'tool_result_commit'])
  })

  it('replays a Transaction A crash boundary as a pending outbox without inventing a result', async () => {
    const root = await createRoot()
    const firstProcess = new AgentLedgerStore(root)
    await firstProcess.commitToolCall(toolCallEvent, assistantToolMessage, {
      callId: 'call_1', taskId: 'task_1', runId: 'run_1', tool: 'file_read', status: 'pending', updatedAt: 10,
    })

    const restartedProcess = new AgentLedgerStore(root)
    const view = await restartedProcess.materialize()
    expect(view.events.map(event => event.type)).toEqual(['tool_call_requested'])
    expect(view.messages).toEqual([assistantToolMessage])
    expect(view.outbox.call_1).toMatchObject({ status: 'pending' })
    expect(view.outbox.call_1).not.toHaveProperty('resultEventId')
    expect(await restartedProcess.audit()).toEqual([])
  })

  it('rejects Message/Event correlation mismatches before tool execution', async () => {
    const store = new AgentLedgerStore(await createRoot())
    await expect(store.commitToolCall(toolCallEvent, { ...assistantToolMessage, tool_calls: [] }, { callId: 'call_1', taskId: 'task_1', runId: 'run_1', tool: 'file_read', status: 'pending', updatedAt: 10 })).rejects.toThrow('correlation mismatch')
    expect((await store.readTransactions()).length).toBe(0)
  })

  it('removes abandoned temporary writes and ignores them during replay', async () => {
    const root = await createRoot()
    const tmp = path.join(root, 'tmp')
    await mkdir(tmp, { recursive: true })
    const abandoned = path.join(tmp, 'crash.tmp')
    await writeFile(abandoned, '{partial')
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(abandoned, staleAt, staleAt)
    const store = new AgentLedgerStore(root)
    await store.init()
    expect(await readdir(tmp)).toEqual([])
    expect(await store.materialize()).toMatchObject({ messages: [], events: [] })
  })

  it('shares initialization and commit sequencing without deleting another live store temporary file', async () => {
    const root = await createRoot()
    const first = new AgentLedgerStore(root)
    await first.init()
    const liveTemporary = path.join(root, 'tmp', 'in-flight.tmp')
    await writeFile(liveTemporary, '{in-flight')

    const second = new AgentLedgerStore(root)
    await second.init()

    expect(await readdir(path.join(root, 'tmp'))).toContain('in-flight.tmp')
    const transactions = await Promise.all([
      first.commit({ kind: 'event_commit' }),
      second.commit({ kind: 'event_commit' }),
    ])
    expect(transactions.map(item => item.ledgerSequence).sort((a, b) => a - b)).toEqual([1, 2])
    expect((await first.readTransactions()).map(item => item.ledgerSequence)).toEqual([1, 2])
  })

  it('treats snapshots and checkpoints as invalid disposable caches when hashes change or files disappear', async () => {
    const root = await createRoot()
    const store = new AgentLedgerStore(root)
    const snapshot = { cacheVersion: 1, taskId: 'task_1', runId: 'run_1', eventLogPrefixHash: 'hash_1', throughSequence: 0, value: { version: 1, runId: 'run_1', throughSequence: 0, eventLogPrefixHash: 'hash_1', state: { status: 'running' as const, currentStep: '准备运行', completedSteps: [] }, compactTimeline: [], indexes: { toolCalls: {}, approvals: {}, retrievals: {}, artifactIds: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0, costUsd: 0, hasEstimatedCost: false, operationIds: [] } } } }
    const checkpoint = { cacheVersion: 1, taskId: 'task_1', runId: 'run_1', eventLogPrefixHash: 'hash_1', throughSequence: 0, value: { version: 1, taskId: 'task_1', runId: 'run_1', throughSequence: 0, eventLogPrefixHash: 'hash_1', messageCursor: 'msg_1', messageTranscriptHash: 'transcript_1', nextStep: 1, completedCallDigests: [] } }
    await store.writeSnapshot(snapshot)
    await store.writeCheckpoint(checkpoint)
    expect(await store.readSnapshot('run_1', 'hash_1')).not.toBeNull()
    expect(await store.readCheckpoint('run_1', 'hash_1')).not.toBeNull()
    expect(await store.readSnapshot('run_1', 'different')).toBeNull()
    expect(await store.readCheckpoint('run_1', 'different')).toBeNull()
    await Promise.all([
      rm(path.join(root, 'snapshots', 'run_1.json'), { force: true }),
      rm(path.join(root, 'checkpoints', 'run_1.json'), { force: true }),
    ])
    expect(await store.readSnapshot('run_1', 'hash_1')).toBeNull()
    expect(await store.readCheckpoint('run_1', 'hash_1')).toBeNull()
    expect(await store.materialize()).toMatchObject({ messages: [], events: [] })
  })
})

describe('AgentArtifactStore', () => {
  it('revalidates beforeHash and refuses to overwrite a user edit', async () => {
    const workspace = await createRoot()
    await writeFile(path.join(workspace, 'note.md'), 'before', 'utf8')
    const root = path.join(workspace, '.looma', 'ai-assistant', 'v3')
    const store = new AgentArtifactStore(root)
    const artifact: FilePatchArtifact = {
      artifactId: 'artifact_1', taskId: 'task_1', runId: 'run_1', callId: 'call_1', approvalId: 'approval_1', workspaceId: 'workspace_1', path: 'note.md', operation: 'update', beforeHash: sha256Text('before'), afterHash: sha256Text('after'), diff: '-before\n+after', proposedContent: 'after', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    }
    await store.save(artifact)
    await writeFile(path.join(workspace, 'note.md'), 'user edit', 'utf8')
    await expect(store.apply(workspace, 'workspace_1', 'artifact_1')).resolves.toMatchObject({ status: 'conflict', expectedHash: sha256Text('before'), actualHash: sha256Text('user edit') })
    expect(await readFile(path.join(workspace, 'note.md'), 'utf8')).toBe('user edit')
  })

  it('applies a hash-bound patch once and recognizes an already-applied retry', async () => {
    const workspace = await createRoot()
    await writeFile(path.join(workspace, 'note.md'), 'before', 'utf8')
    const store = new AgentArtifactStore(path.join(workspace, '.looma', 'ai-assistant', 'v3'))
    const artifact: FilePatchArtifact = {
      artifactId: 'artifact_2', taskId: 'task_1', runId: 'run_1', callId: 'call_1', approvalId: 'approval_1', workspaceId: 'workspace_1', path: 'note.md', operation: 'update', beforeHash: sha256Text('before'), afterHash: sha256Text('after'), diff: '-before\n+after', proposedContent: 'after', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    }
    await store.save(artifact)
    await expect(store.apply(workspace, 'workspace_1', 'artifact_2')).resolves.toMatchObject({ status: 'applied' })
    await expect(store.apply(workspace, 'workspace_1', 'artifact_2')).resolves.toMatchObject({ status: 'already_applied' })
    expect(await readFile(path.join(workspace, 'note.md'), 'utf8')).toBe('after')
  })

  it('cleans only the staged revision whose hash matches the resolved artifact', async () => {
    const workspace = await createRoot()
    const store = new AgentArtifactStore(path.join(workspace, '.looma', 'agent-ledger'))
    const stagingRoot = path.join(workspace, '.looma', 'agent-staging', 'run_1')
    const stagedPath = path.join(stagingRoot, 'files', 'note.md')
    const basePath = path.join(stagingRoot, 'base', 'note.md')
    const metaPath = path.join(stagingRoot, 'meta', `${sha256Text('note.md').slice('sha256:'.length)}.json`)
    await Promise.all([
      mkdir(path.dirname(stagedPath), { recursive: true }),
      mkdir(path.dirname(basePath), { recursive: true }),
      mkdir(path.dirname(metaPath), { recursive: true }),
    ])
    await Promise.all([
      writeFile(stagedPath, 'newer staged content', 'utf8'),
      writeFile(basePath, 'before', 'utf8'),
      writeFile(metaPath, '{}', 'utf8'),
    ])

    await expect(store.cleanupStagedFile(workspace, 'run_1', 'note.md', sha256Text('older proposal'))).resolves.toBe(false)
    expect(await readFile(stagedPath, 'utf8')).toBe('newer staged content')
    await expect(store.cleanupStagedFile(workspace, 'run_1', 'note.md', sha256Text('newer staged content'))).resolves.toBe(true)
    await expect(readFile(stagedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await Promise.all([
      mkdir(path.dirname(basePath), { recursive: true }),
      mkdir(path.dirname(metaPath), { recursive: true }),
    ])
    await Promise.all([
      writeFile(basePath, 'orphan base', 'utf8'),
      writeFile(metaPath, '{}', 'utf8'),
    ])
    await expect(store.cleanupStagedFile(workspace, 'run_1', 'note.md', sha256Text('missing staged file'))).resolves.toBe(true)
    await expect(readFile(basePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(metaPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects protected paths and tampered proposed content', async () => {
    const workspace = await createRoot()
    const store = new AgentArtifactStore(path.join(workspace, '.looma', 'ai-assistant', 'v3'))
    const base: FilePatchArtifact = {
      artifactId: 'artifact_3', taskId: 'task_1', runId: 'run_1', callId: 'call_1', approvalId: 'approval_1', workspaceId: 'workspace_1', path: '.looma/secret', operation: 'create', beforeHash: null, afterHash: sha256Text('safe'), diff: '+safe', proposedContent: 'safe', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    }
    await expect(store.save(base)).rejects.toThrow('protected')
    await expect(store.save({ ...base, artifactId: 'artifact_4', path: 'safe.md', proposedContent: 'tampered' })).rejects.toThrow('afterHash mismatch')
  })
})
