import fs from 'fs/promises'
import path from 'path'
import type { Result } from '../../common/interface/Result'
import { workspaceService } from './workspaceService'

const META_DIR_NAME = '.looma'
const AI_DIR_NAME = 'ai-assistant'
const AI_STATE_FILE_NAME = 'state.json'
const LEGACY_META_FILE_NAME = 'workspace.json'

export interface AiAssistantState {
  conversations: {
    id: string
    title: string
    createdAt: number
    updatedAt: number
    messages: AiAssistantMessage[]
    draft: string
  }[]
  activeConversationId: string
}

interface AiAssistantMessage {
  id: number
  role: 'assistant' | 'user' | 'system'
  text: string
  createdAt: number
  actions?: {
    type: 'build-index'
    title: string
    description: string
    buttonText: string
    disabled?: boolean
  }[]
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
    conversations: [conversation],
    activeConversationId: conversation.id,
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

const normalizeAiAssistantState = (value: unknown): AiAssistantState => {
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
          actions: normalizeActions(item.actions),
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
      conversations,
      activeConversationId,
    }
  }

  const legacyMessages = normalizeMessages(raw.messages)
  if (legacyMessages.length > 0 || typeof raw.draft === 'string') {
    const conversation = createDefaultConversation(legacyMessages.length > 0 ? legacyMessages : undefined, typeof raw.draft === 'string' ? raw.draft : '')
    return {
      conversations: [conversation],
      activeConversationId: conversation.id,
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
        return { success: true, data: normalizeAiAssistantState(JSON.parse(raw)) }
      }

      const migrated = await readLegacyAiAssistant(workspaceId)
      const initialState = migrated ?? createDefaultAiAssistantState()
      await workspaceAiService.setState(workspaceId, initialState)
      return { success: true, data: initialState }
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
