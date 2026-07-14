import { ipcMain, type WebContents } from 'electron'
import {
  aiService,
  normalizeAgentRunOptions,
  type AgentRunOptions,
  type AgentStreamEvent,
} from '../services/ai/AIService'
import { getWorkspacePathById } from './workspaceIpc'

const MAX_ACTIVE_AGENT_RUNS_PER_SENDER = 4
const MAX_ACTIVE_AGENT_RUNS_GLOBAL = 32

type ActiveAgentRun = {
  controller: AbortController
  sender: WebContents
  onDestroyed: () => void
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
  run.sender.send('agent:runStream:event', { ...payload, requestId })
}

ipcMain.handle('agent:runStream:start', async (event, requestId: unknown, workspaceId: unknown, rawOptions: unknown) => {
  if (!validIdentifier(requestId)) return { success: false, error: 'Invalid Agent request ID' }
  if (!validIdentifier(workspaceId)) return { success: false, error: 'Invalid workspace ID' }

  let options: ReturnType<typeof normalizeAgentRunOptions>
  try {
    options = normalizeAgentRunOptions((rawOptions ?? {}) as AgentRunOptions)
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
