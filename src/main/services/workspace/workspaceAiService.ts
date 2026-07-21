import fs from 'fs/promises'
import path from 'path'
import type { Result } from '../../../shared/types/Result'
import { workspaceService } from './workspaceService'
import { migrateLegacyAgentState } from '../agent/AgentLegacyMigration'

const META_DIR_NAME = '.looma'
const AI_DIR_NAME = 'ai-assistant'
const AI_STATE_FILE_NAME = 'state.json'
const LEGACY_META_FILE_NAME = 'workspace.json'

export interface AiAssistantState {
  schemaVersion?: number
  conversations: {
    id: string
    title: string
    createdAt: number
    updatedAt: number
    messages: AiAssistantMessage[]
    draft: string
    archived?: boolean
    archivedAt?: number
    pinned?: boolean
    pinnedAt?: number
    favorite?: boolean
    favoriteCategory?: string
    titleEdited?: boolean
  }[]
  activeConversationId: string | null
  temporaryDraft?: string
  isTemporaryConversation?: boolean
}

interface AiAssistantMessage {
  id: number
  role: 'assistant' | 'user' | 'system'
  text: string
  createdAt: number
  aiName?: string
  actions?: {
    type: 'build-index'
    title: string
    description: string
    buttonText: string
    disabled?: boolean
  }[]
  timeline?: AiAssistantTimelineStep[]
  taskId?: string
  runId?: string
  mode?: 'rag' | 'agent'
  modelIdentity?: { provider: string; model: string; displayName: string }
  agentSummary?: {
    status: 'running' | 'completed' | 'cancelled' | 'error'
    toolCallCount?: number
    sourceCount?: number
    error?: { message: string; technicalDetail?: string }
  }
}

type AiAssistantTimelineStepStatus = 'pending' | 'active' | 'completed' | 'error'
type AiAssistantTimelineOutputType = 'text' | 'source' | 'metric' | 'code' | 'json' | 'error'

interface AiAssistantTimelineOutput {
  id: string
  type: AiAssistantTimelineOutputType
  title?: string
  content?: string
  technicalDetail?: string
  value?: string | number
  unit?: string
  path?: string
  metadata?: Record<string, unknown>
}

interface AiAssistantTimelineStep {
  id: string
  title: string
  description?: string
  detail?: string
  status: AiAssistantTimelineStepStatus
  startedAt: number
  endedAt?: number
  outputs: AiAssistantTimelineOutput[]
}

const TOOL_ARGUMENTS_TITLE = '调用参数'
const MAX_PERSISTED_TOOL_ARGUMENTS = 4_000
const SENSITIVE_TOOL_ARGUMENT_KEY = /(api[-_]?key|token|authorization|cookie|password|passwd|secret|credential|private[-_]?key|access[-_]?key)/i

const sanitizePersistedToolArgumentValue = (value: unknown, depth = 0): unknown => {
  if (depth >= 5) return '[已省略过深内容]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.slice(0, 1_000)
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizePersistedToolArgumentValue(item, depth + 1))
  if (!value || typeof value !== 'object') return String(value ?? '')
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    result[key] = SENSITIVE_TOOL_ARGUMENT_KEY.test(key)
      ? '[已脱敏]'
      : sanitizePersistedToolArgumentValue(item, depth + 1)
  }
  return result
}

const normalizePersistedToolArguments = (value: string) => {
  try {
    const sanitized = sanitizePersistedToolArgumentValue(JSON.parse(value))
    const pretty = JSON.stringify(sanitized, null, 2)
    if (pretty.length <= MAX_PERSISTED_TOOL_ARGUMENTS) return pretty
    const compact = JSON.stringify(sanitized)
    return compact.length <= MAX_PERSISTED_TOOL_ARGUMENTS ? compact : '{"truncated":true}'
  } catch {
    return '{}'
  }
}

const createConversationId = () => `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const getConversationTitle = (messages: AiAssistantMessage[]) => {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.text.trim())
  const title = firstUserMessage?.text.trim().replace(/\s+/g, ' ') || '新对话'
  return title.length > 24 ? `${title.slice(0, 24)}...` : title
}

const createDefaultConversation = (messages?: AiAssistantMessage[], draft = '') => {
  const now = Date.now()
  const nextMessages = messages ?? [
    {
      id: 1,
      role: 'assistant',
      text: '你好，我是 Looma AI 助手。请先为当前工作空间建立索引，然后就可以向我提问。',
      createdAt: 1,
      aiName: 'Looma AI',
    },
  ]
  const timestamps = nextMessages.map((message) => message.createdAt).filter(Number.isFinite)
  const createdAt = timestamps.length > 0 ? Math.min(...timestamps) : now
  const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : now
  return {
    id: createConversationId(),
    title: getConversationTitle(nextMessages),
    createdAt,
    updatedAt,
    messages: nextMessages,
    draft,
  }
}

const createDefaultAiAssistantState = (): AiAssistantState => {
  const conversation = createDefaultConversation()
  return {
    schemaVersion: 2,
    conversations: [conversation],
    activeConversationId: conversation.id,
    temporaryDraft: '',
    isTemporaryConversation: false,
  }
}

const getWorkspacePath = async (workspaceId: string): Promise<string | null> => {
  const stateRes = await workspaceService.getState()
  if (!stateRes.success || !stateRes.data) return null
  const ws = stateRes.data.workspaces.find(w => w.id === workspaceId)
  return ws ? ws.path : null
}

const getMetaDirPath = async (workspaceId: string): Promise<string | null> => {
  const wsPath = await getWorkspacePath(workspaceId)
  if (!wsPath) return null
  return path.join(wsPath, META_DIR_NAME)
}

const getAiDirPath = async (workspaceId: string): Promise<string | null> => {
  const metaDirPath = await getMetaDirPath(workspaceId)
  if (!metaDirPath) return null
  return path.join(metaDirPath, AI_DIR_NAME)
}

const getAiStatePath = async (workspaceId: string): Promise<string | null> => {
  const aiDirPath = await getAiDirPath(workspaceId)
  if (!aiDirPath) return null
  return path.join(aiDirPath, AI_STATE_FILE_NAME)
}

const getLegacyMetaPath = async (workspaceId: string): Promise<string | null> => {
  const metaDirPath = await getMetaDirPath(workspaceId)
  if (!metaDirPath) return null
  return path.join(metaDirPath, LEGACY_META_FILE_NAME)
}

export const normalizeAiAssistantState = (value: unknown): AiAssistantState => {
  if (!value || typeof value !== 'object') return createDefaultAiAssistantState()
  const raw = value as any

  const normalizeActions = (actions: unknown) => {
    if (!Array.isArray(actions)) return undefined
    const normalized = actions
      .filter((item: any) =>
        item
        && item.type === 'build-index'
        && typeof item.title === 'string'
        && typeof item.description === 'string'
        && typeof item.buttonText === 'string',
      )
      .map((item: any) => ({
        type: item.type,
        title: item.title,
        description: item.description,
        buttonText: item.buttonText,
        disabled: Boolean(item.disabled),
      }))
    return normalized.length > 0 ? normalized : undefined
  }

  const normalizeTimelinePath = (value: unknown) => {
    if (typeof value !== 'string') return undefined
    const path = value.trim().replace(/\\+/g, '/')
    if (!path || path.startsWith('/') || /^[a-zA-Z]:\//.test(path) || path.startsWith('//')) return undefined
    const segments = path.split('/').filter(Boolean)
    if (!segments.length || segments.some(segment => segment === '.' || segment === '..' || segment.includes(':') || segment.toLowerCase() === '.looma')) return undefined
    return segments.join('/')
  }

  const normalizeTimelineMetadata = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const raw = value as Record<string, unknown>
    const normalized: Record<string, unknown> = {}
    if (typeof raw.score === 'number' && Number.isFinite(raw.score)) normalized.score = raw.score
    for (const key of ['source', 'file_path', 'path'] as const) {
      const safePath = normalizeTimelinePath(raw[key])
      if (safePath) normalized[key] = safePath
    }
    return Object.keys(normalized).length ? normalized : undefined
  }

  const normalizeTimelineOutputs = (outputs: unknown): AiAssistantTimelineOutput[] => (
    Array.isArray(outputs)
      ? outputs
        .filter((item: any) =>
          item
          && typeof item.id === 'string'
          && (item.type === 'text' || item.type === 'source' || item.type === 'metric' || item.type === 'code' || item.type === 'json' || item.type === 'error'),
        )
        .map((item: any) => {
          const title = typeof item.title === 'string' ? item.title.slice(0, 200) : undefined
          const rawContent = typeof item.content === 'string' ? item.content : undefined
          const content = rawContent === undefined
            ? undefined
            : title === TOOL_ARGUMENTS_TITLE
              ? normalizePersistedToolArguments(rawContent)
              : rawContent.slice(0, 20_000)
          return {
            id: item.id,
            type: item.type,
            title,
            content,
            technicalDetail: typeof item.technicalDetail === 'string' ? item.technicalDetail.slice(0, 2000) : undefined,
            value: typeof item.value === 'string' || typeof item.value === 'number' ? item.value : undefined,
            unit: typeof item.unit === 'string' ? item.unit : undefined,
            path: normalizeTimelinePath(item.path),
            metadata: normalizeTimelineMetadata(item.metadata),
          }
        })
      : []
  )

  const normalizeTimeline = (timeline: unknown) => {
    if (!Array.isArray(timeline)) return undefined
    const normalized = timeline
      .filter((item: any) =>
        item
        && typeof item.id === 'string'
        && typeof item.title === 'string'
        && (item.status === 'pending' || item.status === 'active' || item.status === 'completed' || item.status === 'error')
        && typeof item.startedAt === 'number',
      )
      .map((item: any) => ({
        id: item.id,
        title: item.title,
        description: typeof item.description === 'string' ? item.description : undefined,
        detail: typeof item.detail === 'string' ? item.detail : undefined,
        status: item.status,
        startedAt: item.startedAt,
        endedAt: typeof item.endedAt === 'number' ? item.endedAt : undefined,
        outputs: normalizeTimelineOutputs(item.outputs),
      }))
    return normalized.length > 0 ? normalized : undefined
  }

  const normalizeModelIdentity = (value: unknown) => {
    if (!value || typeof value !== 'object') return undefined
    const raw = value as Record<string, unknown>
    if (typeof raw.provider !== 'string' || typeof raw.model !== 'string' || typeof raw.displayName !== 'string') return undefined
    if (!raw.provider.trim() || !raw.model.trim() || !raw.displayName.trim()) return undefined
    return { provider: raw.provider.trim(), model: raw.model.trim(), displayName: raw.displayName.trim() }
  }

  const normalizeAgentSummary = (value: unknown) => {
    if (!value || typeof value !== 'object') return undefined
    const raw = value as Record<string, any>
    if (!['running', 'completed', 'cancelled', 'error'].includes(raw.status)) return undefined
    return {
      status: raw.status,
      toolCallCount: typeof raw.toolCallCount === 'number' && Number.isFinite(raw.toolCallCount) ? Math.max(0, Math.round(raw.toolCallCount)) : undefined,
      sourceCount: typeof raw.sourceCount === 'number' && Number.isFinite(raw.sourceCount) ? Math.max(0, Math.round(raw.sourceCount)) : undefined,
      error: raw.error && typeof raw.error === 'object' && typeof raw.error.message === 'string'
        ? {
            message: raw.error.message.slice(0, 1000),
            technicalDetail: typeof raw.error.technicalDetail === 'string' ? raw.error.technicalDetail.slice(0, 2000) : undefined,
          }
        : undefined,
    }
  }

  const normalizeMessages = (messages: unknown): AiAssistantMessage[] => (
    Array.isArray(messages)
      ? messages
        .filter((item: any) =>
          item
          && typeof item.id === 'number'
          && (item.role === 'assistant' || item.role === 'user' || item.role === 'system')
          && typeof item.text === 'string',
        )
        .map((item: any) => ({
          id: item.id,
          role: item.role,
          text: item.text,
          createdAt: typeof item.createdAt === 'number' ? item.createdAt : item.id,
          aiName: typeof item.aiName === 'string' && item.aiName.trim() ? item.aiName.trim() : undefined,
          actions: normalizeActions(item.actions),
          timeline: normalizeTimeline(item.timeline),
          ...(typeof item.taskId === 'string' && item.taskId.trim() ? { taskId: item.taskId.trim() } : {}),
          ...(typeof item.runId === 'string' && item.runId.trim() ? { runId: item.runId.trim() } : {}),
          ...(item.mode === 'rag' || item.mode === 'agent' ? { mode: item.mode } : {}),
          ...(normalizeModelIdentity(item.modelIdentity) ? { modelIdentity: normalizeModelIdentity(item.modelIdentity) } : {}),
          ...(normalizeAgentSummary(item.agentSummary) ? { agentSummary: normalizeAgentSummary(item.agentSummary) } : {}),
        }))
      : []
  )

  const normalizeConversation = (item: any) => {
    if (!item || typeof item !== 'object') return null
    const messages = normalizeMessages(item.messages)
    const now = Date.now()
    const createdAt = typeof item.createdAt === 'number' ? item.createdAt : now
    const updatedAt = typeof item.updatedAt === 'number' ? item.updatedAt : createdAt
    const id = typeof item.id === 'string' && item.id ? item.id : createConversationId()
    const title = typeof item.title === 'string' && item.title.trim()
      ? item.title.trim()
      : getConversationTitle(messages)
    return {
      id,
      title,
      createdAt,
      updatedAt,
      messages,
      draft: typeof item.draft === 'string' ? item.draft : '',
      archived: Boolean(item.archived),
      archivedAt: typeof item.archivedAt === 'number' ? item.archivedAt : undefined,
      pinned: Boolean(item.pinned),
      pinnedAt: typeof item.pinnedAt === 'number' ? item.pinnedAt : undefined,
      favorite: Boolean(item.favorite),
      favoriteCategory: typeof item.favoriteCategory === 'string' && item.favoriteCategory.trim()
        ? item.favoriteCategory.trim()
        : undefined,
      titleEdited: Boolean(item.titleEdited),
    }
  }

  const conversations = Array.isArray(raw.conversations)
    ? raw.conversations.map(normalizeConversation).filter(Boolean) as AiAssistantState['conversations']
    : []

  if (conversations.length > 0) {
    const activeConversationId = conversations.some((conversation) => conversation.id === raw.activeConversationId)
      ? raw.activeConversationId
      : [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0].id
    return {
      schemaVersion: 2,
      conversations,
      activeConversationId,
      temporaryDraft: typeof raw.temporaryDraft === 'string' ? raw.temporaryDraft : '',
      isTemporaryConversation: false,
    }
  }

  if (Array.isArray(raw.conversations)) {
    return {
      schemaVersion: 2,
      conversations: [],
      activeConversationId: null,
      temporaryDraft: typeof raw.temporaryDraft === 'string' ? raw.temporaryDraft : '',
      isTemporaryConversation: Boolean(raw.isTemporaryConversation) || !raw.activeConversationId,
    }
  }

  const legacyMessages = normalizeMessages(raw.messages)
  if (legacyMessages.length > 0 || typeof raw.draft === 'string') {
    const conversation = createDefaultConversation(legacyMessages.length > 0 ? legacyMessages : undefined, typeof raw.draft === 'string' ? raw.draft : '')
    return {
      schemaVersion: 2,
      conversations: [conversation],
      activeConversationId: conversation.id,
      temporaryDraft: '',
      isTemporaryConversation: false,
    }
  }

  return createDefaultAiAssistantState()
}

const lockFile = async (filePath: string, maxRetries = 5, retryDelay = 50) => {
  const lockPath = `${filePath}.lock`
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' })
      return async () => {
        try { await fs.unlink(lockPath) } catch {}
      }
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err
      await new Promise(resolve => setTimeout(resolve, retryDelay))
    }
  }
  try { await fs.unlink(lockPath) } catch {}
  await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' })
  return async () => {
    try { await fs.unlink(lockPath) } catch {}
  }
}

const ensureAiStateDir = async (workspaceId: string) => {
  const aiDirPath = await getAiDirPath(workspaceId)
  if (!aiDirPath) return null

  try {
    const stat = await fs.stat(aiDirPath)
    if (stat.isFile()) {
      await fs.unlink(aiDirPath)
    }
  } catch {}

  await fs.mkdir(aiDirPath, { recursive: true })
  return aiDirPath
}

const readLegacyAiAssistant = async (workspaceId: string) => {
  const legacyMetaPath = await getLegacyMetaPath(workspaceId)
  if (!legacyMetaPath) return null

  let unlock: (() => Promise<void>) | null = null
  try {
    unlock = await lockFile(legacyMetaPath)
    const raw = await fs.readFile(legacyMetaPath, 'utf-8')
    const parsed = JSON.parse(raw) as any
    if (!parsed.aiAssistant) return null

    const nextMeta = { ...parsed }
    delete nextMeta.aiAssistant
    await fs.writeFile(legacyMetaPath, JSON.stringify(nextMeta, null, 2), 'utf-8')
    return normalizeAiAssistantState(parsed.aiAssistant)
  } catch (err: any) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
      console.warn('迁移 AI 助手状态失败。', err)
    }
    return null
  } finally {
    if (unlock) await unlock()
  }
}

export const workspaceAiService = {
  async getState(workspaceId: string): Promise<Result<AiAssistantState>> {
    let unlock: (() => Promise<void>) | null = null
    try {
      const statePath = await getAiStatePath(workspaceId)
      if (!statePath) return { success: true, data: createDefaultAiAssistantState() }

      let raw: string | null = null
      try {
        unlock = await lockFile(statePath)
        raw = await fs.readFile(statePath, 'utf-8')
      } catch (err: any) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err
      }

      if (unlock) {
        await unlock()
        unlock = null
      }

      if (raw) {
        const parsed = JSON.parse(raw)
        const normalized = normalizeAiAssistantState(parsed)
        const workspacePath = await getWorkspacePath(workspaceId)
        if (!workspacePath) return { success: true, data: normalized }
        const migration = await migrateLegacyAgentState(workspacePath, normalized)
        if ((parsed as any)?.schemaVersion !== 2 || migration.migratedRunIds.length > 0) {
          await workspaceAiService.setState(workspaceId, migration.state)
        }
        return { success: true, data: migration.state }
      }

      const migrated = await readLegacyAiAssistant(workspaceId)
      const initialState = migrated ?? createDefaultAiAssistantState()
      const workspacePath = await getWorkspacePath(workspaceId)
      const migratedState = workspacePath
        ? (await migrateLegacyAgentState(workspacePath, initialState)).state
        : initialState
      await workspaceAiService.setState(workspaceId, migratedState)
      return { success: true, data: migratedState }
    } catch (err) {
      if (unlock) await unlock()
      console.warn('读取 AI 助手状态失败。', err)
      return { success: true, data: createDefaultAiAssistantState() }
    }
  },

  async setState(workspaceId: string, state: AiAssistantState): Promise<Result<void>> {
    let unlock: (() => Promise<void>) | null = null
    try {
      await ensureAiStateDir(workspaceId)
      const statePath = await getAiStatePath(workspaceId)
      if (!statePath) return { success: false, error: '工作空间路径不存在' }

      unlock = await lockFile(statePath)
      await fs.writeFile(statePath, JSON.stringify(normalizeAiAssistantState(state), null, 2), 'utf-8')

      if (unlock) await unlock()
      return { success: true }
    } catch (error: any) {
      if (unlock) await unlock()
      return { success: false, error: `保存 AI 助手状态失败: ${error?.message ?? String(error)}` }
    }
  },
}
