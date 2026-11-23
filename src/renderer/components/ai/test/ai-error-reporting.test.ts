import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { useWorkspaceStore } from '../../../stores/workspace'
import { useAiAssistantStore } from '../../../stores/ai-assistant'

// Exercise the component's actual handlers with real stores, without mounting browser-only UI.
const script = parse(readFileSync('src/renderer/components/ai/AiAssistant.vue', 'utf8')).descriptor.scriptSetup!.content
const source = ts.createSourceFile('AiAssistant.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const handlerNames = new Set(['appendMessage', 'indexWorkspace', 'askQuestion'])
const handlers = source.statements.filter(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => handlerNames.has(declaration.name.getText(source))))
const handlerCode = ts.transpileModule(handlers.map(statement => statement.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

const createHandlers = () => {
  const workspace = useWorkspaceStore()
  return new Function('workspaceStore', 'aiAssistStore', 'getActiveWorkspaceId', 'question', 'isGenerating', 'aiDisplayName', 'isBuildIndexDisabled', 'scrollToBottom',
    `${handlerCode}\nreturn { askQuestion, indexWorkspace }`)(
    workspace, useAiAssistantStore(), () => workspace.activeWorkspaceId,
    { value: '检查工作空间' }, { value: false }, { value: '测试模型' }, { value: false }, () => {},
  ) as { askQuestion: () => Promise<void>; indexWorkspace: () => Promise<void> }
}

const errorMessage = '服务暂时不可用，请稍后重试。'
const installApi = () => ({
  workspaceAi: { set: vi.fn().mockResolvedValue({ success: true }) },
  agent: { runStream: { start: vi.fn(), onEvent: vi.fn(() => vi.fn()) } },
  rag: { indexStream: { start: vi.fn(), onEvent: vi.fn(() => vi.fn()) } },
})
let api: ReturnType<typeof installApi>
let conversationId: string

beforeEach(() => {
  setActivePinia(createPinia())
  api = installApi()
  vi.stubGlobal('window', { electronAPI: api })
  const workspace = useWorkspaceStore()
  workspace.activeWorkspaceId = 'workspace-1'
  workspace.startTemporaryAiAssistantConversation()
  conversationId = workspace.ensureAiAssistantConversationForRequest()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const messages = () => useWorkspaceStore().getAiAssistantConversationById(conversationId)!.messages

describe('AI startup error reporting', () => {
  it.each(['rejected', 'thrown'])('shows an Agent startup failure only once when IPC is %s', async (failure) => {
    if (failure === 'rejected') api.agent.runStream.start.mockResolvedValue({ success: false, error: errorMessage })
    else api.agent.runStream.start.mockRejectedValue(new Error(errorMessage))

    await createHandlers().askQuestion()

    expect(api.agent.runStream.start).toHaveBeenCalledOnce()
    expect(messages().filter(message => message.role !== 'user')).toHaveLength(1)
    expect(messages().find(message => message.role === 'assistant')).toMatchObject({
      text: errorMessage, agentSummary: { status: 'error' },
    })
  })

  it.each(['rejected', 'thrown'])('shows an index startup failure only once when IPC is %s', async (failure) => {
    if (failure === 'rejected') api.rag.indexStream.start.mockResolvedValue({ success: false, error: errorMessage })
    else api.rag.indexStream.start.mockRejectedValue(new Error(errorMessage))

    await createHandlers().indexWorkspace()

    expect(api.rag.indexStream.start).toHaveBeenCalledOnce()
    expect(messages()).toHaveLength(1)
    expect(messages()[0].role).toBe('assistant')
    expect(messages()[0].text).toContain(errorMessage)
  })

  it('keeps a system notice when context preparation fails before an assistant message exists', async () => {
    vi.spyOn(useAiAssistantStore(), 'buildConversationHistoryForRequest').mockRejectedValue(new Error(errorMessage))

    await createHandlers().askQuestion()

    expect(api.agent.runStream.start).not.toHaveBeenCalled()
    expect(messages()).toHaveLength(1)
    expect(messages()[0]).toMatchObject({ role: 'system', text: errorMessage })
  })

  it('keeps a system notice when index validation fails before a message exists', async () => {
    useAiAssistantStore().indexStreamsByWorkspaceId['workspace-1'] = {} as any

    await createHandlers().indexWorkspace()

    expect(api.rag.indexStream.start).not.toHaveBeenCalled()
    expect(messages()).toHaveLength(1)
    expect(messages()[0]).toMatchObject({ role: 'system', text: '当前工作空间正在建立索引，请等待完成。' })
  })
})
