import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchEditorFocus, EDITOR_FOCUS_EVENT, getEditorFocusLabel } from '../editor-focus'

afterEach(() => { vi.unstubAllGlobals() })

describe('正文焦点事件', () => {
  it('生成简短中文标签，去除 Markdown 标记并保留 Unicode 字符', () => {
    expect(getEditorFocusLabel('### **当前标题**', 'markdown')).toBe('当前标题')
    expect(getEditorFocusLabel('- [x] 阅读 [笔记](other.md)', 'markdown')).toBe('阅读 笔记')
    expect(getEditorFocusLabel('  多行\n 段落  ')).toBe('多行 段落')
    expect(getEditorFocusLabel('')).toBe('空白段落')
    expect(getEditorFocusLabel('不展示实现', 'code')).toBe('代码块')
    expect(getEditorFocusLabel('照片', 'image')).toBe('图片：照片')
    expect(getEditorFocusLabel('', 'image')).toBe('图片')
    expect(getEditorFocusLabel('| 列一 | 列二 |', 'markdown')).toBe('表格')
    expect(getEditorFocusLabel('| --- | --- |', 'markdown')).toBe('表格')
    expect(getEditorFocusLabel('单元格', 'table')).toBe('表格')
    expect(getEditorFocusLabel('', 'separator')).toBe('分隔线')
    expect(getEditorFocusLabel('🙂'.repeat(80))).toBe('🙂'.repeat(48) + '…')
  })
  it('每次点击都派发相同焦点，不合并重复事件', () => {
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    const received: unknown[] = []
    target.addEventListener('looma:editor-focus', event => received.push((event as CustomEvent).detail))
    const detail = { relativePath: '目录/笔记.md', label: '当前段落', sourceLine: 3 }
    dispatchEditorFocus(detail)
    dispatchEditorFocus(detail)
    expect(EDITOR_FOCUS_EVENT).toBe('looma:editor-focus')
    expect(received).toEqual([detail, detail])
  })
})
