import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('实际聊天接入懒渲染和问题导航，不再按全部消息循环或无条件拉回底部', () => {
  const source = readFileSync(new URL('../AiAssistant.vue', import.meta.url), 'utf8')
  expect(source).toContain('v-for="message in visibleMessages"')
  expect(source).toContain(':data-chat-question-id="message.role === \'user\' ? message.id : undefined"')
  expect(source).toContain('<AiQuestionNav')
  expect(source).toContain('@select="jumpToQuestion"')
  expect(source).toContain('data-chat-content')
  expect(source).toContain('handleScroll()')
  expect(source).not.toContain('watch(() => messages.value.length, scrollToBottom)')
})

it('空会话的内容容器保持满高，避免新对话卡片由居中变成贴顶', () => {
  const source = readFileSync(new URL('../AiAssistant.vue', import.meta.url), 'utf8')
  expect(source.includes("'h-full': messages.length === 0")).toBe(true)
})
