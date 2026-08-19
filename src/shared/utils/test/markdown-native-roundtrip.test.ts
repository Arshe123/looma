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
} from '../markdown-rich-text'
import { ResizableMarkdownImage } from '../resizable-markdown-image'

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

const createResizableImageManager = () => new MarkdownManager({
  extensions: [StarterKit, ResizableMarkdownImage.configure({ inline: false })],
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

  it('preserves a percentage image width through the Tiptap Markdown AST', () => {
    const manager = createResizableImageManager()
    const markdown = '![架构图](assets/architecture.png){width=60%}'
    const doc = manager.parse(markdown)

    expect(doc.content?.[0]?.attrs?.widthPercent).toBe(60)
    expect(serialize(manager, doc)).toBe(markdown)
  })

  it('keeps an existing image title while persisting its width', () => {
    const manager = createResizableImageManager()
    const markdown = '![架构图](assets/architecture.png "产品架构"){width=60%}'

    expect(serialize(manager, manager.parse(markdown))).toBe(markdown)
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

describe('CJK strong bold 边界（marked tokenizer）', () => {
  const findBoldText = (doc: JSONContent): string[] => {
    const results: string[] = []
    const walk = (node: JSONContent) => {
      if (node.marks?.some(mark => mark.type === 'bold') && node.text) {
        results.push(node.text)
      }
      node.content?.forEach(walk)
    }
    walk(doc)
    return results
  }

  it('中文引号包裹的 bold 解析为 bold mark', () => {
    const manager = createManager()
    const doc = manager.parse('日记里这个平台叫**“全球疫情数据分析和风险评估平台”**，也就是')
    expect(findBoldText(doc)).toContain('“全球疫情数据分析和风险评估平台”')
  })

  it('中文括号结尾的 bold 解析为 bold mark', () => {
    const manager = createManager()
    const doc = manager.parse('准确来说，**8月13日（第9天）**就是')
    expect(findBoldText(doc)).toContain('8月13日（第9天）')
  })

  it('默认能解析的英文 bold 仍走默认 tokenizer', () => {
    const manager = createManager()
    const doc = manager.parse('this is **bold** text')
    expect(findBoldText(doc)).toContain('bold')
  })

  it('默认能解析的中文 bold 不受影响', () => {
    const manager = createManager()
    const doc = manager.parse('根据你的实习日记，**亚林哥是在实习第9天**让你去看')
    expect(findBoldText(doc)).toContain('亚林哥是在实习第9天')
  })

  it('bold 内侧带空格仍不解析（CommonMark 默认行为）', () => {
    const manager = createManager()
    const doc = manager.parse('** bold ** should not match')
    expect(findBoldText(doc)).toEqual([])
  })

  it('CJK bold 序列化回 markdown 仍保留 ** 语法', () => {
    const manager = createManager()
    const doc = manager.parse('准确来说，**8月13日（第9天）**就是')
    expect(serialize(manager, doc)).toBe('准确来说，**8月13日（第9天）**就是')
  })

  it('英文双引号包裹的 bold 解析为 bold mark', () => {
    const manager = createManager()
    const doc = manager.parse('日记里叫**"平台"**，后续')
    expect(findBoldText(doc)).toContain('"平台"')
  })

  it('英文括号包裹的 bold 解析为 bold mark', () => {
    const manager = createManager()
    const doc = manager.parse('前缀**(注释)**后缀')
    expect(findBoldText(doc)).toContain('(注释)')
  })

  it('英文句号结尾的 bold 解析为 bold mark', () => {
    const manager = createManager()
    const doc = manager.parse('前缀**bold.**后缀')
    expect(findBoldText(doc)).toContain('bold.')
  })
})
