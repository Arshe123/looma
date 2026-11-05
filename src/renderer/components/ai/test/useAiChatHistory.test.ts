import { effectScope, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiAssistantMessage } from '@/renderer/stores/workspace-types'
import { useAiChatHistory } from '../useAiChatHistory'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.unstubAllGlobals()
})
const turns = (count: number): AiAssistantMessage[] => Array.from({ length: count }, (_, i) => [
  { id: i * 3 + 1, role: 'user' as const, text: `问题 ${i + 1}`, createdAt: i },
  { id: i * 3 + 2, role: 'assistant' as const, text: `回答 ${i + 1}`, createdAt: i },
  { id: i * 3 + 3, role: 'system' as const, text: '工具与系统结果', createdAt: i },
]).flat()
const setup = (initial = turns(15)) => {
  const messages = ref(initial)
  const key = ref('workspace-a/conversation-a')
  const container = ref<HTMLElement | null>(null)
  const scope = effectScope()
  scopes.push(scope)
  const history = scope.run(() => useAiChatHistory(messages, () => key.value, container))!
  return { messages, key, container, history }
}

describe('聊天历史按轮懒渲染', () => {
  it('打开聊天只显示最后五轮，保留一轮内的回复与系统事件，导航包含全部问题', () => {
    const { history, messages } = setup()
    expect(history.visibleMessages.value.map(message => message.id)).toEqual(turns(15).slice(30).map(message => message.id))
    expect(history.questions.value).toHaveLength(15)
    expect(history.hasEarlier.value).toBe(true)
    expect(messages.value).toHaveLength(45)
  })

  it('每次补载五轮并补偿滚动高度，最后保留会话开头的系统消息', async () => {
    const initial = [{ id: -1, role: 'system' as const, text: '会话起点', createdAt: 0 }, ...turns(12)]
    const { history, container } = setup(initial)
    const element = {
      scrollTop: 0,
      get scrollHeight() { return history.visibleMessages.value.length * 100 },
      getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
      querySelectorAll: () => [],
    }
    container.value = element as unknown as HTMLElement
    expect(history.visibleMessages.value).toHaveLength(15)
    await history.loadEarlier()
    expect(history.visibleMessages.value).toHaveLength(30)
    expect(element.scrollTop).toBe(1500)
    await history.loadEarlier()
    expect(history.visibleMessages.value).toHaveLength(37)
    expect(history.visibleMessages.value[0]?.id).toBe(-1)
    expect(history.hasEarlier.value).toBe(false)
    await history.loadEarlier()
    expect(history.visibleMessages.value).toHaveLength(37)
  })

  it('导航到未渲染的问题时按页补载并准确定位，不修改原消息', async () => {
    const { history, container, messages } = setup()
    const target = { getBoundingClientRect: () => ({ top: 280 }) }
    const element = {
      scrollTop: 80,
      getBoundingClientRect: () => ({ top: 100 }),
      querySelector: vi.fn(() => target),
      querySelectorAll: () => [],
    }
    container.value = element as unknown as HTMLElement
    await history.jumpToQuestion(7)
    expect(history.visibleMessages.value[0]?.id).toBe(1)
    expect(element.querySelector).toHaveBeenCalledWith('[data-chat-question-id="7"]')
    expect(element.scrollTop).toBe(244)
    expect(history.activeQuestionId.value).toBe(7)
    expect(history.highlightedQuestionId.value).toBe(7)
    expect(messages.value).toEqual(turns(15))
    await history.jumpToQuestion(999)
    expect(element.scrollTop).toBe(244)
  })

  it('同一会话异步填充历史时仍只显示最近五轮；切换工作空间后重置', async () => {
    const { history, messages, key } = setup([])
    messages.value.push(...turns(15))
    await nextTick()
    expect(history.visibleMessages.value).toHaveLength(15)
    await history.loadEarlier()
    expect(history.visibleMessages.value).toHaveLength(30)
    key.value = 'workspace-b/conversation-a'
    await nextTick()
    expect(history.visibleMessages.value).toHaveLength(15)
  })

  it('切换会话会取消迟到的补载和定位，不能更改新会话滚动位置', async () => {
    const { history, key, container } = setup()
    const element = {
      scrollTop: 10,
      get scrollHeight() { return history.visibleMessages.value.length * 100 },
      querySelector: vi.fn(() => ({ getBoundingClientRect: () => ({ top: 200 }) })),
      getBoundingClientRect: () => ({ top: 0 }),
    }
    container.value = element as unknown as HTMLElement
    const loading = history.loadEarlier()
    key.value = 'workspace-b/conversation-b'
    await loading
    expect(element.scrollTop).toBe(10)
    expect(history.loadingEarlier.value).toBe(false)
    const jumping = history.jumpToQuestion(1)
    key.value = 'workspace-c/conversation-c'
    await jumping
    expect(element.querySelector).not.toHaveBeenCalled()
    expect(history.highlightedQuestionId.value).toBe(null)
  })

  it('触顶自动补载，滚动更新当前问题；阅读旧消息时新回复不拉回底部', async () => {
    const { history, container, messages } = setup()
    const element = {
      scrollTop: 600, clientHeight: 400,
      get scrollHeight() { return history.visibleMessages.value.length * 100 },
      getBoundingClientRect: () => ({ top: 0 }),
      querySelectorAll: () => history.visibleMessages.value.flatMap((message, index) => message.role === 'user' ? [{
        dataset: { chatQuestionId: String(message.id) },
        getBoundingClientRect: () => ({ top: index * 100 - element.scrollTop }),
      }] : []),
    }
    container.value = element as unknown as HTMLElement
    await history.handleScroll()
    expect(history.activeQuestionId.value).toBe(37)
    messages.value.push(...turns(16).slice(-3))
    await nextTick()
    expect(element.scrollTop).toBe(600)
    element.scrollTop = 0
    await history.handleScroll()
    expect(history.visibleMessages.value).toHaveLength(33)
    expect(element.scrollTop).toBe(1500)
    await history.scrollToBottom()
    expect(element.scrollTop).toBe(element.scrollHeight)
    messages.value.push({ id: 60, role: 'assistant', text: '继续回复', createdAt: 0 })
    await nextTick()
    await nextTick()
    expect(element.scrollTop).toBe(element.scrollHeight)
  })

  it('流式回复增高时仅在底部跟随，并在卸载后移除尺寸监听', async () => {
    let resize!: () => void
    const disconnect = vi.fn()
    const observe = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe = observe
      disconnect = disconnect
    })
    const { history, container } = setup()
    const element = {
      scrollTop: 1100, scrollHeight: 1500, clientHeight: 400,
      querySelector: () => ({}),
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 0 }),
    }
    container.value = element as unknown as HTMLElement
    await nextTick()
    expect(observe).toHaveBeenCalledTimes(2)
    element.scrollHeight = 1800
    resize()
    await nextTick()
    expect(element.scrollTop).toBe(1800)
    element.scrollTop = 400
    history.handleScroll()
    element.scrollHeight = 2000
    resize()
    await nextTick()
    expect(element.scrollTop).toBe(400)
    scopes.at(-1)!.stop()
    expect(disconnect).toHaveBeenCalled()
  })

  it('历史图片延迟撑高上方内容时持续补偿阅读锚点，不把下方增长计入偏移', async () => {
    let resize!: () => void
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe() {}
      disconnect() {}
    })
    const { history, container } = setup()
    let documentTop = 620
    const anchor = { getBoundingClientRect: () => ({ top: documentTop - element.scrollTop, bottom: documentTop - element.scrollTop + 100 }) }
    const element = {
      scrollTop: 600, scrollHeight: 1500, clientHeight: 400,
      getBoundingClientRect: () => ({ top: 0, bottom: 400 }),
      querySelector: () => ({}),
      querySelectorAll: (selector: string) => selector === '[data-chat-question-id]' ? [] : [anchor],
      contains: (node: unknown) => node === anchor,
    }
    container.value = element as unknown as HTMLElement
    await nextTick()
    history.handleScroll()
    documentTop += 300
    element.scrollHeight += 300
    resize()
    expect(element.scrollTop).toBe(900)
    expect(anchor.getBoundingClientRect().top).toBe(20)
    element.scrollHeight += 200
    resize()
    expect(element.scrollTop).toBe(900)
  })
})
