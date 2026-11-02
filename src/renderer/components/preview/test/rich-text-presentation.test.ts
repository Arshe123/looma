import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const ordinary = read('../TiptapPreview.vue')
const continuous = read('../../editor/ChunkedMarkdownEditor.vue')

describe('shared rich-text presentation', () => {
  it('loads the same engine-independent line-number and table presentation in both editors', () => {
    for (const source of [ordinary, continuous]) {
      expect(source).toContain("import '@/renderer/styles/rich-text-presentation.css'")
    }
  })
})
