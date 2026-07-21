import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateLegacyAgentState, type LegacyAgentState } from '../AgentLegacyMigration'
import { AgentLedgerStore } from '../AgentLedgerStore'

const temporaryDirectories: string[] = []

const createWorkspace = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'looma-agent-migration-'))
  temporaryDirectories.push(directory)
  return directory
}

const createLegacyState = (status: 'running' | 'completed' | 'cancelled' | 'error' = 'completed'): LegacyAgentState => ({
  conversations: [{
    id: 'conversation-legacy',
    messages: [
      { id: 1, role: 'user', text: '读取旧文档', createdAt: 100 },
      {
        id: 2,
        role: 'assistant',
        text: status === 'completed' ? '已经读取。' : '',
        createdAt: 110,
        mode: 'agent',
        agentSummary: { status, toolCallCount: 1, sourceCount: 1 },
        timeline: [{
          id: 'step-read',
          title: '调用 file_read',
          detail: status === 'error' ? '读取失败' : '读取完成',
          status: status === 'running' ? 'active' : status === 'error' ? 'error' : 'completed',
          startedAt: 120,
          endedAt: status === 'running' ? undefined : 140,
          outputs: [
            { id: 'arguments', type: 'json', title: '调用参数', content: '{"path":"docs/legacy.md","token":"[已脱敏]"}' },
            { id: 'source', type: 'source', path: 'docs/legacy.md', content: '旧版来源片段', metadata: { score: 0.8 } },
            ...(status === 'error'
              ? [{ id: 'error', type: 'error' as const, content: '读取失败', technicalDetail: 'LegacyReadError' }]
              : []),
          ],
        }],
      },
    ],
  }],
})

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('legacy Agent state migration', () => {
  it('converts legacy timeline facts into a replayable ledger and strips the old timeline', async () => {
    const workspacePath = await createWorkspace()
    const state = createLegacyState('completed')

    const result = await migrateLegacyAgentState(workspacePath, state)
    const message = result.state.conversations[0].messages[1]
    const ledger = new AgentLedgerStore(path.join(workspacePath, '.looma', 'agent-ledger'))
    const view = await ledger.materialize()

    expect(result.state.schemaVersion).toBe(2)
    expect(result.migratedRunIds).toHaveLength(1)
    expect(message.taskId).toMatch(/^task_migrated_/)
    expect(message.runId).toMatch(/^run_migrated_/)
    expect(message.timeline).toBeUndefined()
    expect(view.events.filter(event => event.runId === message.runId).map(event => event.type)).toEqual([
      'agent_started',
      'tool_call_requested',
      'tool_result_recorded',
      'retrieval_completed',
      'run_completed',
    ])
    expect(view.sources).toEqual([
      expect.objectContaining({ runId: message.runId, path: 'docs/legacy.md', snippet: '旧版来源片段', score: 0.8 }),
    ])
    expect(view.messages.map(item => item.role)).toEqual(['user', 'assistant'])
    expect(await ledger.audit()).toEqual([])
  })

  it('is idempotent and does not append a second run on repeated migration', async () => {
    const workspacePath = await createWorkspace()
    const state = createLegacyState('completed')
    const first = await migrateLegacyAgentState(workspacePath, state)
    const ledger = new AgentLedgerStore(path.join(workspacePath, '.looma', 'agent-ledger'))
    const firstTransactionCount = (await ledger.readTransactions()).length

    const second = await migrateLegacyAgentState(workspacePath, first.state)

    expect(second.migratedRunIds).toEqual([])
    expect((await ledger.readTransactions()).length).toBe(firstTransactionCount)
    expect(Object.keys((await ledger.materialize()).runs)).toHaveLength(1)
  })

  it('marks a legacy running record as interrupted and explicitly unrecoverable', async () => {
    const workspacePath = await createWorkspace()
    const result = await migrateLegacyAgentState(workspacePath, createLegacyState('running'))
    const message = result.state.conversations[0].messages[1]
    const view = await new AgentLedgerStore(path.join(workspacePath, '.looma', 'agent-ledger')).materialize()
    const events = view.events.filter(event => event.runId === message.runId)

    expect(events.map(event => event.type)).toContain('run_interrupted')
    expect(events.map(event => event.type)).toContain('recovery_failed')
    expect(message.agentSummary).toMatchObject({
      status: 'error',
      error: { message: expect.stringContaining('需要重新发起任务') },
    })
    expect(events.find(event => event.type === 'run_interrupted')?.payload).toMatchObject({ recoverable: false })
  })

  it('falls back to an empty argument preview for malformed legacy JSON', async () => {
    const workspacePath = await createWorkspace()
    const state = createLegacyState('completed')
    state.conversations[0].messages[1].timeline![0].outputs[0].content = '{bad json'

    await migrateLegacyAgentState(workspacePath, state)
    const view = await new AgentLedgerStore(path.join(workspacePath, '.looma', 'agent-ledger')).materialize()
    const call = view.events.find(event => event.type === 'tool_call_requested')

    expect(call?.type === 'tool_call_requested' ? call.payload.argumentsPreview : null).toEqual({})
  })
})
