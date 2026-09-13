import { describe, expect, it } from 'vitest'
import * as reading from '../note-reading-time'
import MarkdownIt from 'markdown-it'
import { Schema } from '@tiptap/pm/model'

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, text: { group: 'inline' },
  paragraph: { group: 'block', content: 'inline*' },
  heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
  blockquote: { group: 'block', content: 'block+' },
  codeBlock: { group: 'block', content: 'text*' },
  image: { group: 'inline', inline: true, attrs: { alt: { default: '' } } },
} })
const block = (type: string, text = '') => schema.node(type, null, text ? schema.text(text) : undefined)
const md = new MarkdownIt()

describe('reading estimate', () => {
  it('counts Han characters and other Unicode words with a shared rounded rate', () => {
    expect(reading.estimateReadingMinutes('中'.repeat(400))).toBe(1)
    expect(reading.estimateReadingMinutes('𠀀'.repeat(401))).toBe(2)
    expect(reading.estimateReadingMinutes('word '.repeat(200))).toBe(1)
    expect(reading.estimateReadingMinutes('中'.repeat(200) + 'word '.repeat(101))).toBe(2)
    expect(reading.estimateReadingMinutes('123 café привет')).toBe(1)
    expect(reading.estimateReadingMinutes('，。!? \n')).toBe(0)
    expect(reading.estimateReadingMinutes('')).toBe(0)
  })
  it('extracts whole-document visible text without code, images, URLs or HTML markup in both adapters', () => {
    const text = '中'.repeat(399)
    const tokens = md.parse(`# ${text}\n\n[中](https://example.com) **中** \`中\` ![${'中'.repeat(900)}](image.png)\n\n\`\`\`\n${'中'.repeat(900)}\n\`\`\`\n\n<!-- ignored --> <b></b> https://example.com`, {})
    expect(reading.readMarkdownReadingMinutes(tokens)).toBe(2)
    const doc = schema.node('doc', null, [block('heading', text), schema.node('paragraph', null, [schema.text('中中中'), schema.node('image', { alt: '中'.repeat(900) })]), block('codeBlock', '中'.repeat(900)), block('paragraph', '<!-- ignored --> <b></b> https://example.com')])
    expect(reading.readDocumentReadingMinutes(doc)).toBe(2)
    expect(reading.readMarkdownReadingMinutes(md.parse('a\n\nb\n\nc', {}))).toBe(1)
  })
  it('recognizes only the first nonempty top-level block, including setext titles', () => {
    for (const source of ['\n\n# Title\n\n# Later', 'Title\n=====']) {
      expect(reading.findMarkdownNoteTitle(md.parse(source, {}))).not.toBeNull()
    }
    for (const source of ['#\n\n# Later', 'text\n\n# Later', '> # Nested', '- # Nested', '```\n# Code\n```', '![image](x)\n\n# Later']) {
      expect(reading.findMarkdownNoteTitle(md.parse(source, {}))).toBeNull()
    }
    const title = block('heading', 'Title')
    expect(reading.findDocumentNoteTitle(schema.node('doc', null, [block('paragraph', ' \t '), title]))).toEqual({ from: 5, to: 12 })
    expect(reading.findDocumentNoteTitle(schema.node('doc', null, [block('paragraph'), title, block('heading', 'Later')]))).toEqual({ from: 2, to: 9 })
    for (const first of [block('paragraph', 'body'), block('heading'), schema.node('blockquote', null, title)]) {
      expect(reading.findDocumentNoteTitle(schema.node('doc', null, [first, title]))).toBeNull()
    }
  })
})
