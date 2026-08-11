import { describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import {
  computeLineNumberPositions,
  createLineNumbersPlugin,
  getOverlayPositionAtLineNumber,
} from '../tiptap-line-numbers'

/** 与应用使用的节点类型对齐的最小 schema（用于离线构造文档）。 */
const schema = new Schema({
  marks: {},
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 } },
      parseDOM: [{ tag: 'h1' }],
      toDOM: () => ['h1', 0],
    },
    codeBlock: { group: 'block', content: 'text*', code: true, parseDOM: [{ tag: 'pre' }], toDOM: () => ['pre', 0] },
    hardBreak: { inline: true, group: 'inline', selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
    blockquote: { group: 'block', content: 'block+', parseDOM: [{ tag: 'blockquote' }], toDOM: () => ['blockquote', 0] },
    bulletList: { group: 'block', content: 'listItem+', parseDOM: [{ tag: 'ul' }], toDOM: () => ['ul', 0] },
    listItem: { content: 'paragraph block*', parseDOM: [{ tag: 'li' }], toDOM: () => ['li', 0] },
    image: {
      group: 'block',
      atom: true,
      attrs: { src: { default: '' } },
      parseDOM: [{ tag: 'img' }],
      toDOM: () => ['img'],
    },
    horizontalRule: { group: 'block', atom: true, parseDOM: [{ tag: 'hr' }], toDOM: () => ['hr'] },
    table: {
      group: 'block',
      content: 'tableRow+',
      tableRole: 'table',
      parseDOM: [{ tag: 'table' }],
      toDOM: () => ['table', 0],
    },
    tableRow: {
      content: '(tableHeader | tableCell)+',
      tableRole: 'row',
      parseDOM: [{ tag: 'tr' }],
      toDOM: () => ['tr', 0],
    },
    tableHeader: {
      content: 'paragraph+',
      tableRole: 'header_cell',
      isolating: true,
      attrs: {
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
      parseDOM: [{ tag: 'th' }],
      toDOM: () => ['th', 0],
    },
    tableCell: {
      content: 'paragraph+',
      tableRole: 'cell',
      isolating: true,
      attrs: {
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
      parseDOM: [{ tag: 'td' }],
      toDOM: () => ['td', 0],
    },
  },
})

const docFromJSON = (content: unknown[]) => schema.nodeFromJSON({ type: 'doc', content })

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const heading = (level: number, text: string) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
})
const code = (text: string) => ({ type: 'codeBlock', content: [{ type: 'text', text }] })

describe('computeLineNumberPositions（源码行号）', () => {
  it('顶层块之间计入空行分隔（a/空行/b → 1, 3）', () => {
    const doc = docFromJSON([p('first'), heading(1, 'Title'), p('third')])
    const positions = computeLineNumberPositions(doc)

    expect(positions).toEqual([
      { pos: 1, line: 1 },
      { pos: 8, line: 3 },
      { pos: 15, line: 5 },
    ])
  })

  it('代码块：开 fence 占一行，内容行从 fence+1 起，关 fence 后再接空行', () => {
    const doc = docFromJSON([p('before'), code('a\nb\nc'), p('after')])
    const positions = computeLineNumberPositions(doc)

    // before=1；代码块 fence=3，内容行 4/5/6；after=9
    expect(positions).toEqual([
      { pos: 1, line: 1 },
      { pos: 9, line: 4 },
      { pos: 11, line: 5 },
      { pos: 13, line: 6 },
      { pos: 16, line: 9 },
    ])
  })

  it('空段落占一行（a/空行/空段落/空行/b → 1, 3, 5）', () => {
    const doc = docFromJSON([p('a'), { type: 'paragraph' }, p('b')])
    const positions = computeLineNumberPositions(doc)
    expect(positions.map(item => item.line)).toEqual([1, 3, 5])
  })

  it('列表项内软换行各占一行', () => {
    const doc = docFromJSON([p('a\nb'), p('c')])
    const positions = computeLineNumberPositions(doc)
    // a(1) b(2) 空行(3) c(4)
    expect(positions.map(item => item.line)).toEqual([1, 4])
  })

  it('hardBreak 占一行', () => {
    const doc = docFromJSON([
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] },
      p('c'),
    ])
    const positions = computeLineNumberPositions(doc)
    expect(positions.map(item => item.line)).toEqual([1, 4])
  })

  it('列表项连续编号，列表后接空行', () => {
    const doc = docFromJSON([
      p('intro'),
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [p('item one')] },
          { type: 'listItem', content: [p('item two')] },
        ],
      },
      p('outro'),
    ])
    const positions = computeLineNumberPositions(doc)
    // intro=1；列表项 3,4；outro=6
    expect(positions.map(item => item.line)).toEqual([1, 3, 4, 6])
  })

  it('引用块内段落之间计入空格行', () => {
    const doc = docFromJSON([
      {
        type: 'blockquote',
        content: [p('quote one'), p('quote two')],
      },
      p('after'),
    ])
    const positions = computeLineNumberPositions(doc)
    // > quote one(1) / >(2) / > quote two(3) / 空行(4) / after(5)
    expect(positions.map(item => item.line)).toEqual([1, 3, 5])
  })

  it('图片与分隔线各占一行（含之间的空行）', () => {
    const doc = docFromJSON([p('a'), { type: 'image', attrs: { src: 'x.png' } }, { type: 'horizontalRule' }, p('b')])
    const positions = computeLineNumberPositions(doc)
    // a(1) 空行(2) 图(3) 空行(4) ---(5) 空行(6) b(7)
    expect(positions.map(item => item.line)).toEqual([1, 3, 5, 7])
  })

  it('表格占 行数+2 行（前导空行+表头+分隔行+数据行），行号不渲染但计数占位', () => {
    const doc = docFromJSON([
      p('before'),
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [p('h1')] },
              { type: 'tableHeader', content: [p('h2')] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [p('c1')] },
              { type: 'tableCell', content: [p('c2')] },
            ],
          },
        ],
      },
      p('after'),
    ])
    const positions = computeLineNumberPositions(doc)
    // before=1；表格占 4 行（前导空行2 + 表头3 + 分隔4 + 数据5）→ after=9
    expect(positions.map(item => item.line)).toEqual([1, 9])
  })

  it('嵌套列表项与上级列表项连续编号', () => {
    const doc = docFromJSON([
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              p('outer'),
              {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [p('inner')] }],
              },
            ],
          },
          { type: 'listItem', content: [p('second')] },
        ],
      },
    ])
    const positions = computeLineNumberPositions(doc)
    // outer=1 / inner=2 / second=3
    expect(positions.map(item => item.line)).toEqual([1, 2, 3])
  })

  it('返回空文档单一行号', () => {
    const doc = docFromJSON([{ type: 'paragraph' }])
    const positions = computeLineNumberPositions(doc)
    expect(positions).toEqual([{ pos: 1, line: 1 }])
  })
})

describe('getOverlayPositionAtLineNumber（行菜单覆盖行号）', () => {
  it('让 24px 菜单按钮与固定行号栏的水平和垂直中心完全重合', () => {
    expect(getOverlayPositionAtLineNumber({
      lineNumberRect: { top: 120, left: 80, width: 8, height: 14 },
      containerRect: { top: 40, left: 20 },
      scrollTop: 30,
      scrollLeft: 10,
      overlaySize: 24,
    })).toEqual({
      top: 105,
      left: 62,
    })
  })
})

describe('createLineNumbersPlugin（当前行）', () => {
  it('选择变化时加粗当前行号并把背景装饰移动到当前文本块', () => {
    const doc = docFromJSON([p('first'), p('second')])
    const plugin = createLineNumbersPlugin()
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 2),
      plugins: [plugin],
    })

    const readDecorations = () => {
      const decorations = plugin.getState(state)?.find() || []
      return {
        lineNumbers: decorations
          .filter(decoration => typeof decoration.spec.lineNumber === 'number')
          .map(decoration => ({
            line: decoration.spec.lineNumber,
            active: decoration.spec.activeLine === true,
          })),
        activeBlocks: decorations
          .filter(decoration => decoration.spec.activeLineBlock === true)
          .map(decoration => ({ from: decoration.from, to: decoration.to })),
      }
    }

    expect(readDecorations()).toEqual({
      lineNumbers: [{ line: 1, active: true }, { line: 3, active: false }],
      activeBlocks: [{ from: 0, to: 7 }],
    })

    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 9)))

    expect(readDecorations()).toEqual({
      lineNumbers: [{ line: 1, active: false }, { line: 3, active: true }],
      activeBlocks: [{ from: 7, to: 15 }],
    })
  })

  it('图片行号使用图片节点装饰，而不是会落到图片底部的普通 widget', () => {
    const doc = docFromJSON([
      p('before'),
      { type: 'image', attrs: { src: 'x.png' } },
      p('after'),
    ])
    const plugin = createLineNumbersPlugin()
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 2),
      plugins: [plugin],
    })
    const decorations = plugin.getState(state)?.find() || []

    expect(decorations
      .filter(decoration => typeof decoration.spec.lineNumber === 'number'
        && decoration.spec.imageLineNumber !== true)
      .map(decoration => decoration.spec.lineNumber)).toEqual([1, 5])
    expect(decorations
      .filter(decoration => decoration.spec.imageLineNumber === true)
      .map(decoration => ({
        from: decoration.from,
        to: decoration.to,
        line: decoration.spec.lineNumber,
      }))).toEqual([{ from: 8, to: 9, line: 3 }])
  })
})