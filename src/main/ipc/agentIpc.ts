import { ipcMain, type WebContents } from 'electron'
import {
  aiService,
  normalizeAgentRunOptions,
  type AgentRunOptions,
  type AgentStreamEvent,
  type AgentFileProposalPayload,
} from '../services/ai/AIService'
import { applyAgentFileProposal } from '../services/file/fileSystemService'
import { getWorkspacePathById } from './workspaceIpc'

const MAX_ACTIVE_AGENT_RUNS_PER_SENDER = 4
const MAX_ACTIVE_AGENT_RUNS_GLOBAL = 32

type ActiveAgentRun = {
  controller: AbortController
  sender: WebContents
  onDestroyed: () => void
  workspacePath: string
  approvals: Map<string, { proposal: AgentFileProposalPayload; deadlineAt: string; status: 'pending' | 'resolving' | 'resolved' }>
}

export const activeAgentRuns = new Map<string, ActiveAgentRun>()

const runKey = (senderId: number, requestId: string) => `${senderId}:${requestId}`
const validIdentifier = (value: unknown): value is string => typeof value === 'string'
  && value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value)

const cleanupRun = (key: string, run: ActiveAgentRun) => {
  if (activeAgentRuns.get(key) !== run) return
  activeAgentRuns.delete(key)
  run.sender.removeListener('destroyed', run.onDestroyed)
}

export const abortAllAgentRuns = () => {
  for (const [key, run] of activeAgentRuns) {
    run.controller.abort()
    cleanupRun(key, run)
  }
}

const sendEvent = (
  key: string,
  run: ActiveAgentRun,
  requestId: string,
  payload: AgentStreamEvent,
) => {
  if (activeAgentRuns.get(key) !== run || run.controller.signal.aborted || run.sender.isDestroyed()) return
  if (payload.type === 'approval_required') {
    run.approvals.set(payload.approvalId, {
      proposal: payload.proposal,
      deadlineAt: payload.deadlineAt,
      status: 'pending',
    })
    run.sender.send('agent:runStream:event', {
      ...payload,
      proposal: { ...payload.proposal, proposed_content: '' },
      requestId,
    })
    return
  }
  if (payload.type === 'approval_resolved') run.approvals.delete(payload.approvalId)
  run.sender.send('agent:runStream:event', { ...payload, requestId })
}

ipcMain.handle('agent:summarizeConversation', async (_event, messages: unknown, maxChars: unknown) => {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 100) {
    return { success: false, error: 'Invalid Agent summary messages' }
  }
  const normalized = messages
    .filter((message): message is { role: 'user' | 'assistant' | 'system'; content: string } => Boolean(
      message && typeof message === 'object'
      && ['user', 'assistant', 'system'].includes((message as any).role)
      && typeof (message as any).content === 'string'
      && (message as any).content.trim(),
    ))
    .map(message => ({ role: message.role, content: message.content.trim() }))
  const limit = Math.min(8000, Math.max(200, Math.round(Number(maxChars) || 1600)))
  if (!normalized.length) return { success: false, error: 'Agent summary messages are empty' }
  return aiService.summarizeAgentConversation(normalized, limit)
})

ipcMain.handle('agent:runStream:start', async (event, requestId: unknown, workspaceId: unknown, rawOptions: unknown) => {
  if (!validIdentifier(requestId)) return { success: false, error: 'Invalid Agent request ID' }
  if (!validIdentifier(workspaceId)) return { success: false, error: 'Invalid workspace ID' }

  let options: ReturnType<typeof normalizeAgentRunOptions>
  try {
    const rendererOptions = rawOptions && typeof rawOptions === 'object'
      ? rawOptions as Pick<AgentRunOptions, 'input' | 'history'>
      : {} as Pick<AgentRunOptions, 'input' | 'history'>
    // Tool capabilities and execution limits are product policy, not renderer/user settings.
    options = normalizeAgentRunOptions({
      input: rendererOptions.input,
      history: rendererOptions.history,
    })
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Invalid Agent options' }
  }

  const sender = event.sender
  if (sender.isDestroyed()) return { success: false, error: 'Agent window is no longer available' }
  const key = runKey(sender.id, requestId)
  const previous = activeAgentRuns.get(key)
  if (previous) {
    previous.controller.abort()
    cleanupRun(key, previous)
  }

  const senderRunCount = [...activeAgentRuns.values()].filter(run => run.sender.id === sender.id).length
  if (senderRunCount >= MAX_ACTIVE_AGENT_RUNS_PER_SENDER || activeAgentRuns.size >= MAX_ACTIVE_AGENT_RUNS_GLOBAL) {
    return { success: false, error: 'Too many active Agent runs' }
  }

  const controller = new AbortController()
  const run: ActiveAgentRun = {
    controller,
    sender,
    workspacePath: '',
    approvals: new Map(),
    onDestroyed: () => {
      controller.abort()
      cleanupRun(key, run)
    },
  }
  activeAgentRuns.set(key, run)
  sender.once('destroyed', run.onDestroyed)

  let workspacePath: string | null
  try {
    workspacePath = await getWorkspacePathById(workspaceId)
  } catch {
    cleanupRun(key, run)
    return { success: false, error: 'Unable to resolve workspace' }
  }
  if (activeAgentRuns.get(key) !== run || controller.signal.aborted || sender.isDestroyed()) {
    cleanupRun(key, run)
    return { success: false, error: 'Agent request was cancelled' }
  }
  if (!workspacePath) {
    cleanupRun(key, run)
    return { success: false, error: 'Workspace not found' }
  }
  run.workspacePath = workspacePath

  void aiService.streamAgent(
    workspacePath,
    options,
    payload => sendEvent(key, run, requestId, payload),
    controller.signal,
  ).then((result) => {
    if (!result.success) {
      sendEvent(key, run, requestId, {
        type: 'error',
        runId: `bridge_${requestId}`,
        error: {
          code: 'agent_bridge_failed',
          message: 'Agent 服务暂时不可用，请稍后重试。',
          technical_detail: 'AgentBridgeError',
          retryable: true,
        },
      })
    }
  }).catch(() => {
    sendEvent(key, run, requestId, {
      type: 'error',
      runId: `bridge_${requestId}`,
      error: {
        code: 'agent_bridge_failed',
        message: 'Agent 服务暂时不可用，请稍后重试。',
        technical_detail: 'AgentBridgeError',
        retryable: true,
      },
    })
  }).finally(() => cleanupRun(key, run))

  return { success: true }
})

ipcMain.handle('agent:runStream:cancel', async (event, requestId: unknown) => {
  if (!validIdentifier(requestId)) return { success: false, error: 'Invalid Agent request ID' }
  const key = runKey(event.sender.id, requestId)
  const run = activeAgentRuns.get(key)
  if (run) {
    run.controller.abort()
    cleanupRun(key, run)
  }
  return { success: true }
})

ipcMain.handle('agent:approval:resolve', async (event, approvalId: unknown, approved: unknown) => {
  if (!validIdentifier(approvalId) || typeof approved !== 'boolean') {
    return { success: false, error: 'Invalid Agent approval request' }
  }
  const match = [...activeAgentRuns.entries()].find(([, run]) => run.sender.id === event.sender.id && run.approvals.has(approvalId))
  if (!match) return { success: false, error: '审批已失效或不属于当前窗口' }
  const [, run] = match
  const approval = run.approvals.get(approvalId)!
  if (approval.status !== 'pending') return { success: false, error: '审批正在处理，请勿重复操作' }
  if (!Number.isFinite(Date.parse(approval.deadlineAt)) || Date.now() >= Date.parse(approval.deadlineAt)) {
    run.approvals.delete(approvalId)
    return { success: false, error: '审批已过期，请让 Agent 重新生成修改提案' }
  }
  approval.status = 'resolving'

  let applied = false
  let reason = approved ? undefined : '用户拒绝了文件修改'
  if (approved) {
    const result = await applyAgentFileProposal(run.workspacePath, approval.proposal)
    applied = result.success
    reason = result.success ? undefined : result.error || '应用文件修改失败'
  }

  let resolved: Awaited<ReturnType<typeof aiService.resolveAgentApproval>> = { success: false, error: '审批服务不可用' }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    resolved = await aiService.resolveAgentApproval(
      approvalId,
      approved ? 'approved' : 'rejected',
      reason,
      applied,
    )
    if (resolved.success) break
  }
  if (!resolved.success) {
    approval.status = applied ? 'resolved' : 'pending'
    return {
      success: false,
      error: applied
        ? '文件已经写入，但 Agent 未能恢复执行。请检查 Python 服务状态。'
        : resolved.error || '提交审批结果失败',
    }
  }
  approval.status = 'resolved'
  return applied || !approved
    ? { success: true, data: { applied } }
    : { success: false, error: reason || '文件修改未能应用', errorCode: 'AGENT_PATCH_APPLY_FAILED' }
})
