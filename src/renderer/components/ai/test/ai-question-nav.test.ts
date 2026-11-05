import { expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import AiQuestionNav from '../AiQuestionNav.vue'

it('短横线导航包含全部用户问题、中文标签与当前问题状态，安全转义问题', async () => {
  const html = await renderToString(createSSRApp(AiQuestionNav, {
    questions: [
      { id: 1, text: '<script>alert(1)</script>' },
      { id: 2, text: '下一步做什么？' },
    ],
    activeId: 2,
  }))
  expect(html).toContain('用户问题导航')
  expect(html.match(/<button/g)).toHaveLength(2)
  expect(html).toContain('aria-label="第 1 轮：&lt;script&gt;alert(1)&lt;/script&gt;"')
  expect(html).toContain('aria-current="step"')
  expect(html).not.toContain('<script>')
})

it('空会话不显示问题导航', async () => {
  const html = await renderToString(createSSRApp(AiQuestionNav, { questions: [], activeId: null }))
  expect(html).not.toContain('<nav')
})
