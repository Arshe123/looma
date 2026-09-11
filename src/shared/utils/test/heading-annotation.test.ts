import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../../renderer/components/preview/TiptapPreview.vue', import.meta.url), 'utf8')

describe('光标所在标题的等级标注', () => {
  it.each([1, 2, 3, 4, 5, 6])('H%i 无需鼠标悬停即可显示标注', level => {
    const rule = source.match(/[^{}]+\{\s*visibility: visible;\s*opacity: 1;\s*\}/g)
      ?.find(rule => rule.includes(`.tiptap h${level}:hover::after`))
    expect(rule).toContain(`.tiptap:focus-within h${level}.looma-active-line::after`)
  })
})
