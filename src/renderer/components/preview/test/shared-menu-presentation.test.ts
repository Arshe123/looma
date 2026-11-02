import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { Bold, ImagePlus } from 'lucide-vue-next'
import QuickMenuPresentation from '../menus/QuickMenuPresentation.vue'
import MenuPlusButton from '../menus/MenuPlusButton.vue'
import ContextMenuPresentation from '../menus/ContextMenuPresentation.vue'
import { readFileSync } from 'node:fs'
import TableSizePicker from '../TableSizePicker.vue'
import TableToolbarPresentation from '../menus/TableToolbarPresentation.vue'
import { contextClipboardItems, nextMenuIndex } from '../menus/menuPresentation'

const items = [
  { id: 'bold', label: '加粗', icon: Bold, shortcut: '⌘1' },
  { id: 'image', label: '插入图片', icon: ImagePlus, disabled: true },
]

describe('engine-independent quick menu presentation', () => {
  it('shares the exact clipboard contract instead of adapter-specific extra commands', () => {
    const items = contextClipboardItems({ isMac: true, reference: false, sourceCopy: false })
    expect(items.map(item => item.id)).toEqual(['copy', 'copy-source', 'paste'])
    expect(items[1].disabled).toBe(true)
    expect(items[0].shortcut).toBe('⌘C')
    const reference = contextClipboardItems({ isMac: false, reference: true, sourceCopy: true, readOnly: true })
    expect(reference[0].label).toBe('复制引用')
    expect(reference[0].shortcut).toBe('Ctrl+C')
    expect(reference[1].disabled).toBe(false)
    expect(reference[2].disabled).toBe(true)
  })
  it('navigates enabled menu items and the shared picker column count without leaving bounds', () => {
    const enabled = [{ disabled: true }, {}, { disabled: true }, {}, { disabled: true }]
    expect(nextMenuIndex(enabled, 3, 'Home')).toBe(1)
    expect(nextMenuIndex(enabled, 1, 'End')).toBe(3)
    expect(nextMenuIndex(enabled, 1, 'ArrowDown')).toBe(3)
    expect(nextMenuIndex(enabled, 3, 'ArrowDown')).toBe(3)
    expect(nextMenuIndex(enabled, 3, 'ArrowUp')).toBe(1)
    expect(nextMenuIndex(Array.from({ length: 60 }, () => ({})), 0, 'ArrowDown', 10)).toBe(10)
    expect(nextMenuIndex([], 0, 'End')).toBe(-1)
    expect(nextMenuIndex([{ disabled: true }], 0, 'Home')).toBe(-1)
  })
  it('uses the ordinary table copy/size/delete toolbar with the existing resize picker', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(TableToolbarPresentation, { sizePickerVisible: true, currentTableSize: { rows: 2, cols: 4 } }) }))
    for (const title of ['调整表格大小', '复制表格', '删除表格']) expect(html).toContain(`title="${title}"`)
    expect(html).toContain('lucide-table-properties')
    expect(html).toContain('lucide-copy')
    expect(html).toContain('lucide-trash-2')
    expect(html).toContain('table-size-picker__cell--current')
    expect(html).not.toContain('表格操作 ▾')
    const toolbar = readFileSync(new URL('../menus/TableToolbarPresentation.vue', import.meta.url), 'utf8')
    expect(toolbar).toMatch(/\.table-toolbar__picker\s*\{\s*position: absolute;/)
    for (const path of ['../TableToolbar.vue', '../../editor/continuousMarkdownMenus.ts']) {
      expect(readFileSync(new URL(path, import.meta.url), 'utf8')).toContain('TableToolbarPresentation')
    }
  })
  it('reuses the accessible size picker cells with geometry metadata for engine keyboard navigation', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(TableSizePicker, { gridRows: 2, gridCols: 3 }) }))
    expect(html).toContain('data-rows="2" data-columns="3" data-grid-columns="3"')
    expect(html).toContain('aria-label="2 行 × 3 列"')
    expect(html.match(/data-grid-columns="3"/g)).toHaveLength(6)
  })
  it('renders the ordinary context icon grids, paragraph submenu and clipboard section', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(ContextMenuPresentation, {
      textStyleIcons: items.slice(0, 1), blockStyleIcons: items.slice(1),
      listItems: [{ id: 'paragraph', label: '段落', children: [{ id: 'h1', label: '一级标题' }] }],
      clipboardItems: [{ id: 'copy', label: '复制', icon: Bold, shortcut: '⌘C' }],
    }) }))
    expect(html).toContain('w-64 bg-panel')
    expect(html).toContain('w-8 h-8')
    expect(html).toContain('段落')
    expect(html).toContain('lucide-chevron-right')
    expect(html).toContain('复制')
    expect(html).toContain('⌘C')
  })
  it('both engine adapters consume the exact shared visual components', () => {
    const ordinary = readFileSync(new URL('../InlineMenu.vue', import.meta.url), 'utf8')
    const context = readFileSync(new URL('../ContextMenu.vue', import.meta.url), 'utf8')
    const continuous = readFileSync(new URL('../../editor/continuousMarkdownMenus.ts', import.meta.url), 'utf8')
    for (const source of [ordinary, continuous]) {
      expect(source).toContain('QuickMenuPresentation')
      expect(source).toContain('MenuPlusButton')
    }
    for (const source of [context, continuous]) expect(source).toContain('ContextMenuPresentation')
    expect(continuous).toContain('render(null,')
    expect(continuous).not.toContain("createElement('style')")
    expect(continuous).not.toContain('looma-continuous-menu-grid')
  })
  it('renders the ordinary icon list, selected row, shortcut badge and disabled action', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(QuickMenuPresentation, { items, selectedIndex: 0 }) }))
    expect(html).toContain('w-56 bg-panel border border-border-soft rounded-lg shadow-xl')
    expect(html).toContain('lucide-bold')
    expect(html).toContain('bg-accent-soft text-accent')
    expect(html).toContain('⌘1')
    expect(html).toMatch(/data-action="image"[^>]*disabled/)
    expect(html).not.toContain('暂不支持')
  })
  it('uses the same round plus button, not a text glyph', async () => {
    const html = await renderToString(createSSRApp({ render: () => h(MenuPlusButton) }))
    expect(html).toContain('rounded-full bg-panel-soft')
    expect(html).toContain('lucide-plus')
  })
})
