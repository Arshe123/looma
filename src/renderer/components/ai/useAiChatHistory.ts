import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { AiAssistantMessage } from '@/renderer/stores/workspace-types'

const PAGE_SIZE = 5

export const useAiChatHistory = (
  messages: Readonly<Ref<AiAssistantMessage[]>>,
  scopeKey: () => string,
  container: Ref<HTMLElement | null>,
) => {
  const startIndex = ref(0)
  const questions = computed(() => messages.value.flatMap((message, index) => (
    message.role === 'user' ? [{ id: message.id, text: message.text, index }] : []
  )))
  const visibleMessages = computed(() => messages.value.slice(startIndex.value))
  const hasEarlier = computed(() => startIndex.value > 0)
  const loadingEarlier = ref(false)
  const activeQuestionId = ref<number | null>(null)
  const highlightedQuestionId = ref<number | null>(null)
  const followingLatest = ref(true)
  let highlightTimer: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  let readingAnchor: { node: HTMLElement; offset: number } | null = null

  const reset = () => {
    generation += 1
    readingAnchor = null
    loadingEarlier.value = false
    followingLatest.value = true
    highlightedQuestionId.value = null
    activeQuestionId.value = questions.value.at(-1)?.id ?? null
    clearTimeout(highlightTimer)
    const first = questions.value[questions.value.length - PAGE_SIZE]
    startIndex.value = questions.value.length > PAGE_SIZE ? first!.index : 0
  }
  watch([scopeKey, messages], reset, { immediate: true, flush: 'sync' })

  const rememberReadingAnchor = () => {
    readingAnchor = null
    const element = container.value
    if (!element || followingLatest.value) return
    const viewport = element.getBoundingClientRect()
    const edge = viewport.top + 16
    // Images may also grow above the reading position within the same reply.
    const nodes = element.querySelectorAll<HTMLElement>('[data-chat-message-id], [data-chat-message-id] :is(p,h1,h2,h3,h4,h5,h6,pre,li,table)')
    let distance = Infinity
    for (const node of nodes) {
      const rect = node.getBoundingClientRect()
      const nextDistance = Math.abs(rect.top - edge)
      if (rect.bottom > edge && rect.top < viewport.bottom && nextDistance <= distance) {
        readingAnchor = { node, offset: rect.top - viewport.top }
        distance = nextDistance
      }
    }
  }

  const restoreReadingAnchor = () => {
    const element = container.value
    if (element && readingAnchor && element.contains(readingAnchor.node)) {
      const offset = readingAnchor.node.getBoundingClientRect().top - element.getBoundingClientRect().top
      element.scrollTop += offset - readingAnchor.offset
    }
    rememberReadingAnchor()
  }

  const updateActiveQuestion = () => {
    const element = container.value
    if (!element) return
    if (followingLatest.value) {
      activeQuestionId.value = questions.value.at(-1)?.id ?? null
      return
    }
    const edge = element.getBoundingClientRect().top + 64
    const nodes = Array.from(element.querySelectorAll<HTMLElement>('[data-chat-question-id]'))
    const current = nodes.filter(node => node.getBoundingClientRect().top <= edge).at(-1) ?? nodes[0]
    activeQuestionId.value = current ? Number(current.dataset.chatQuestionId) : null
  }

  const scrollToBottom = async () => {
    followingLatest.value = true
    readingAnchor = null
    const token = generation
    await nextTick()
    if (token !== generation || !followingLatest.value) return
    const element = container.value
    if (element) element.scrollTop = element.scrollHeight
    updateActiveQuestion()
  }
  watch(() => messages.value.length, (length, previous) => {
    if (length && !previous) reset()
    if (length > previous && followingLatest.value) void scrollToBottom()
  })

  const loadEarlier = async () => {
    if (!hasEarlier.value || loadingEarlier.value) return
    const token = generation
    const element = container.value
    const oldHeight = element?.scrollHeight ?? 0
    const oldTop = element?.scrollTop ?? 0
    followingLatest.value = false
    loadingEarlier.value = true
    const current = questions.value.findIndex(question => question.index >= startIndex.value)
    const previous = current - PAGE_SIZE
    startIndex.value = previous > 0 ? questions.value[previous]!.index : 0
    await nextTick()
    if (generation !== token) return
    if (element) element.scrollTop = oldTop + element.scrollHeight - oldHeight
    loadingEarlier.value = false
    rememberReadingAnchor()
  }

  const jumpToQuestion = async (id: number) => {
    const ordinal = questions.value.findIndex(question => question.id === id)
    const question = questions.value[ordinal]
    if (!question) return
    const token = ++generation
    readingAnchor = null
    followingLatest.value = false
    loadingEarlier.value = false
    if (question.index < startIndex.value) {
      const page = Math.floor(ordinal / PAGE_SIZE) * PAGE_SIZE
      startIndex.value = page > 0 ? questions.value[page]!.index : 0
    }
    await nextTick()
    if (generation !== token) return
    const element = container.value
    const target = element?.querySelector<HTMLElement>(`[data-chat-question-id="${id}"]`)
    if (!element || !target) return
    element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - 16
    activeQuestionId.value = id
    highlightedQuestionId.value = id
    rememberReadingAnchor()
    clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => { highlightedQuestionId.value = null }, 1200)
  }
  const handleScroll = () => {
    const element = container.value
    if (!element || loadingEarlier.value) return
    followingLatest.value = element.scrollHeight - element.scrollTop - element.clientHeight <= 48
    updateActiveQuestion()
    rememberReadingAnchor()
    if (element.scrollTop <= 8 && hasEarlier.value) return loadEarlier()
  }
  let resizeObserver: ResizeObserver | undefined
  watch(container, (element) => {
    resizeObserver?.disconnect()
    if (!element || typeof ResizeObserver === 'undefined') return
    resizeObserver = new ResizeObserver(() => {
      if (loadingEarlier.value) return
      if (followingLatest.value) void scrollToBottom()
      else {
        restoreReadingAnchor()
        updateActiveQuestion()
      }
    })
    resizeObserver.observe(element)
    const content = element.querySelector<HTMLElement>('[data-chat-content]')
    if (content) resizeObserver.observe(content)
  }, { flush: 'post' })
  onScopeDispose(() => {
    generation += 1
    clearTimeout(highlightTimer)
    resizeObserver?.disconnect()
  })

  return {
    visibleMessages, questions, hasEarlier, loadingEarlier, loadEarlier,
    activeQuestionId, highlightedQuestionId, jumpToQuestion,
    handleScroll, scrollToBottom, followingLatest,
  }
}
