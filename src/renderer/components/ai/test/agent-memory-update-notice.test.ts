import { expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import AgentMemoryUpdateNotice from '../AgentMemoryUpdateNotice.vue'

const updates = [
  { id: 'first', changes: [{ type: 'added' as const, text: '偏好中文\n<script>alert(1)</script>' }] },
  { id: 'second', changes: [{ type: 'removed' as const, text: '旧习惯' }] },
]
it('renders deletion-only and conservative receipts as a static memory icon without an empty disclosure', async () => {
  for (const changes of [[{ type: 'removed' as const, text: 'deleted secret' }], []]) {
    const html = await renderToString(createSSRApp(AgentMemoryUpdateNotice, { messageId: 1, completed: true, updates: [{ id: 'delete', changes }] }))
    expect(html).toContain('记忆已更新')
    expect(html).toContain('lucide-brain')
    expect(html).not.toContain('<button')
    expect(html).not.toContain('aria-expanded')
    expect(html).not.toContain('chevron')
    expect(html).not.toContain('deleted secret')
  }
})
it('hides the notice until terminal and never creates one for legacy/no-change turns', async () => {
  for (const props of [{ completed: false, updates }, { completed: true, updates: [] }]) {
    const html = await renderToString(createSSRApp(AgentMemoryUpdateNotice, { messageId: 1, ...props }))
    expect(html).not.toContain('记忆已更新')
  }
})
it('groups all updates under one collapsed button without losing long text', async () => {
  const long = '🙂中文'.repeat(3000)
  const html = await renderToString(createSSRApp(AgentMemoryUpdateNotice, {
    messageId: 2, completed: true, updates: [...updates, { id: 'third', changes: [{ type: 'added', text: long }] }],
  }))
  expect(html.match(/记忆已更新/g)).toHaveLength(1)
  expect(html.match(/<button/g)).toHaveLength(1)
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain('display:none')
  expect(html).toContain('lucide-brain')
  expect(html).not.toContain('次更新')
  expect(html).not.toContain('旧习惯')
  expect(html).not.toContain('移除')
  expect(html).not.toContain('新增')
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).toContain(long)
  expect(html).toContain('max-h-72')
})
