import { describe, expect, it, vi } from 'vitest'
import type { JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableCell } from '@tiptap/extension-table-cell'
import { MarkdownManager } from '@tiptap/markdown'
import {
  prepareMarkdownForRichText,
  serializeMarkdownAst,
} from './markdown-rich-text'

const createManager = () => new MarkdownManager({
  extensions: [
    StarterKit,
    Image.configure({ inline: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table,
    TableRow,
    TableHeader,
    TableCell,
  ],
})

const serialize = (manager: MarkdownManager, doc: JSONContent) => serializeMarkdownAst({
  getJSON: () => doc,
  markdown: { serialize: value => manager.serialize(value) },
})

describe('official @tiptap/markdown AST serialization', () => {
  it.each([
    ['paragraph', 'plain text', 'plain text'],
    ['trailing list', '- item\n', '- item'],
    ['code block', '```ts\nconst value = 1\n```', '```ts\nconst value = 1\n```'],
    ['image', '![](image.png)', '![](image.png)'],
    ['task list', '- [x] done\n- [ ] open', '- [x] done\n- [ ] open'],
    ['HTML', '<p>html</p>', '&lt;p&gt;html&lt;/p&gt;'],
  ])('serializes a %s document from its complete AST', (_name, markdown, expected) => {
    const manager = createManager()
    expect(serialize(manager, manager.parse(markdown))).toBe(expected)
  })

  it('serializes a table from its complete AST', () => {
    const manager = createManager()
    const doc = manager.parse('| A | B |\n| --- | --- |\n| 1 | 2 |')

    expect(serialize(manager, doc)).toContain('| A')
    expect(serialize(manager, doc)).toContain('| 1')
  })

  it('uses nbsp for consecutive empty paragraphs and reparses the same structure', () => {
    const manager = createManager()
    const doc = manager.parse('before\n\nafter')
    doc.content!.splice(1, 0, { type: 'paragraph' }, { type: 'paragraph' })

    const markdown = serialize(manager, doc)
    expect(markdown).toBe('before\n\n\n\n&nbsp;\n\nafter')
    const reparsed = manager.parse(markdown)
    expect(reparsed.content?.map(node => node.type)).toEqual(doc.content?.map(node => node.type))
    expect(manager.serialize(reparsed)).toBe(markdown)
  })

  it('serializes the two-enters, type, then clear reproduction without block mapping', () => {
    const manager = createManager()
    const doc = manager.parse('before\n\nafter')
    doc.content!.splice(1, 0, { type: 'paragraph' }, { type: 'paragraph' })
    doc.content![2] = { type: 'paragraph', content: [{ type: 'text', text: 'test input' }] }
    doc.content![2] = { type: 'paragraph' }

    expect(() => serialize(manager, doc)).not.toThrow()
    const reparsed = manager.parse(serialize(manager, doc))
    expect(reparsed.content?.map(node => node.type)).toEqual(doc.content?.map(node => node.type))
  })

  it('passes editor.getJSON() directly to the official serializer', () => {
    const doc: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }
    const serializeSpy = vi.fn(() => 'serialized')

    expect(serializeMarkdownAst({
      getJSON: () => doc,
      markdown: { serialize: serializeSpy },
    })).toBe('serialized')
    expect(serializeSpy).toHaveBeenCalledWith(doc)
  })
})

describe('prepareMarkdownForRichText', () => {
  it('separates a standalone image from adjacent body text', () => {
    expect(prepareMarkdownForRichText('![](image.png)\ncaption')).toBe(
      '![](image.png)\n\ncaption',
    )
  })

  it('does not change image syntax inside fenced code blocks', () => {
    const markdown = '```md\n![](image.png)\ncaption\n```'
    expect(prepareMarkdownForRichText(markdown)).toBe(markdown)
  })
})
