import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  workspacePath: '',
  streamEvent: null as null | ((event: any) => void),
  streamAgent: vi.fn(),
  resolveAgentApproval: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  shell: { showItemInFolder: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => state.handlers.set(channel, handler),
  },
}))

vi.mock('../workspaceIpc', () => ({
  getWorkspacePathById: vi.fn(async () => state.workspacePath),
}))

vi.mock('../../services/ai/AIService', () => ({
  aiService: {
    streamAgent: state.streamAgent.mockImplementation(async (_workspace: string, _options: unknown, onEvent: (event: any) => void) => {
      state.streamEvent = onEvent
      return { success: true }
    }),
    resolveAgentApproval: state.resolveAgentApproval,
    summarizeAgentConversation: vi.fn(),
  },
  normalizeAgentRunOptions: vi.fn((value: any) => value),
}))

await import('../agentIpc')

const sha = (value: string) => createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')
const sender = (id: number) => ({
  id,
  isDestroyed: () => false,
  send: vi.fn(),
  once: vi.fn(),
  removeListener: vi.fn(),
})

describe('Agent approval IPC trusted boundary', () => {
  beforeEach(async () => {
    state.workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-agent-ipc-'))
    await fs.mkdir(path.join(state.workspacePath, 'notes'))
    state.streamEvent = null
    state.streamAgent.mockClear()
    state.resolveAgentApproval.mockClear()
  })

  afterEach(async () => {
    await fs.rm(state.workspacePath, { recursive: true, force: true })
  })

  it('keeps proposal content in Main, applies once, and reports applied=true', async () => {
    const owner = sender(101)
    const start = state.handlers.get('agent:runStream:start')!
    expect(await start({ sender: owner }, 'request-1', 'workspace-1', { input: 'create note', enabledTools: ['file_patch'] })).toEqual({ success: true })
    await vi.waitFor(() => expect(state.streamEvent).toBeTypeOf('function'))

    const content = '# approved\n'
    state.streamEvent!({
      type: 'approval_required', runId: 'run-1', step: 1, stepId: 'step-1', callId: 'call-1',
      approvalId: 'approval-1', tool: 'file_patch',
      requestedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      proposal: {
        requiresApproval: true,
        path: 'notes/approved.md', operation: 'create', unified_diff: '--- /dev/null\n+++ notes/approved.md\n+# approved',
        expected_sha256: null, proposed_sha256: sha(content), proposed_content: content,
      },
    })

    expect(owner.send).toHaveBeenCalledWith('agent:runStream:event', expect.objectContaining({
      requestId: 'request-1',
      proposal: expect.objectContaining({ proposed_content: '' }),
    }))

    const resolve = state.handlers.get('agent:approval:resolve')!
    expect(await resolve({ sender: owner }, 'approval-1', true)).toEqual({ success: true, data: { applied: true } })
    expect(await fs.readFile(path.join(state.workspacePath, 'notes/approved.md'), 'utf8')).toBe(content)
    expect(state.resolveAgentApproval).toHaveBeenCalledWith('approval-1', 'approved', undefined, true)

    expect((await resolve({ sender: owner }, 'approval-1', true)).success).toBe(false)
  })

  it('ignores renderer attempts to disable tools or change execution limits', async () => {
    const owner = sender(301)
    await state.handlers.get('agent:runStream:start')!({ sender: owner }, 'request-policy', 'workspace-1', {
      input: 'inspect tools',
      history: [],
      enabledTools: ['file_read'],
      maxSteps: 1,
      toolTimeoutSeconds: 1,
    })
    await vi.waitFor(() => expect(state.streamAgent).toHaveBeenCalled())
    expect(state.streamAgent.mock.calls[0][1]).toEqual({ input: 'inspect tools', history: [] })
  })

  it('rejects cross-window approval without touching disk', async () => {
    const owner = sender(201)
    const attacker = sender(202)
    await state.handlers.get('agent:runStream:start')!({ sender: owner }, 'request-2', 'workspace-1', { input: 'create note', enabledTools: ['file_patch'] })
    await vi.waitFor(() => expect(state.streamEvent).toBeTypeOf('function'))
    const content = 'secret\n'
    state.streamEvent!({
      type: 'approval_required', runId: 'run-2', step: 1, stepId: 'step-2', callId: 'call-2',
      approvalId: 'approval-2', tool: 'file_patch', requestedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      proposal: { requiresApproval: true, path: 'notes/blocked.md', operation: 'create', unified_diff: '+secret', expected_sha256: null, proposed_sha256: sha(content), proposed_content: content },
    })

    expect((await state.handlers.get('agent:approval:resolve')!({ sender: attacker }, 'approval-2', true)).success).toBe(false)
    await expect(fs.stat(path.join(state.workspacePath, 'notes/blocked.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
