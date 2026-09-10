/** 正文交互通知；路径保持工作区相对路径，sourceLine 为可用时的 1-based 源码行号。 */
export interface EditorFocusDetail {
  relativePath: string
  label: string
  sourceLine?: number
}

export const EDITOR_FOCUS_EVENT = 'looma:editor-focus'

export type EditorFocusKind = 'text' | 'markdown' | 'code' | 'image' | 'table' | 'separator'

export function getEditorFocusLabel(text: string, kind: EditorFocusKind = 'text'): string {
  if (kind === 'code') return '代码块'
  if (kind === 'table') return '表格'
  if (kind === 'separator') return '分隔线'
  // 限制输入工作量，避免单个超长段落使每次光标更新扫描全文。
  let label = text.slice(0, 512).trim()
  if (kind === 'markdown') {
    if (/^\|.+\|/.test(label)) return '表格'
    label = label.replace(/^(?:>\s*)+/, '').replace(/^#{1,6}\s+/, '')
      .replace(/^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*`~]|==/g, '').replace(/\s+#+$/, '')
  }
  label = label.replace(/\s+/g, ' ').trim()
  if (kind === 'image') label = label ? `图片：${label}` : '图片'
  const characters = Array.from(label)
  return characters.length > 48 ? `${characters.slice(0, 48).join('')}…` : label || '空白段落'
}

/** 从点击块读取少量 DOM，不查询整个编辑器的段落/行号列表。 */
export function getRenderedEditorFocus(target: Node | null, root: HTMLElement): Omit<EditorFocusDetail, 'relativePath'> | null {
  const element = target?.nodeType === 1 ? target as Element : target?.parentElement
  if (!element || !root.contains(element) || element.closest('button, input, select, textarea, .chunk-load-state')) return null
  const special = element.closest('pre, .code-block-shell, .local-image-node, img, table, hr')
  const block = special || element.closest('h1, h2, h3, h4, h5, h6, p, li, blockquote')
  if (!block || !root.contains(block)) return null
  const kind: EditorFocusKind = block.matches('pre, .code-block-shell') ? 'code'
    : block.matches('img, .local-image-node') ? 'image'
    : block.matches('table') ? 'table' : block.matches('hr') ? 'separator' : 'text'
  let text = ''
  let visited = 0
  const read = (node: Node) => {
    if (++visited > 64 || text.length >= 512) return
    if (node.nodeType === 3) {
      text += (node.nodeValue || '').slice(0, 512 - text.length)
      return
    }
    if (node.nodeType === 1 && (node as Element).matches('.looma-line-number, button, input, [aria-hidden="true"]')) return
    for (let child = node.firstChild; child && visited < 64 && text.length < 512; child = child.nextSibling) read(child)
  }
  if (kind === 'text') read(block)
  if (kind === 'image') text = (block.matches('img') ? block : block.querySelector('img'))?.getAttribute('alt') || ''
  const anchor = element.closest('[data-line]') || (kind !== 'table' ? block.querySelector('.looma-line-number[data-line]') : null)
  const line = Number(anchor?.getAttribute('data-line'))
  return {
    label: getEditorFocusLabel(text, kind),
    ...(Number.isInteger(line) && line > 0 ? { sourceLine: line } : {}),
  }
}

/** 不去重：同一段落的再次点击也必须退出面包屑的临时目录浏览。 */
export function dispatchEditorFocus(detail: EditorFocusDetail): void {
  if (typeof window === 'undefined' || !detail.relativePath) return
  window.dispatchEvent(new CustomEvent<EditorFocusDetail>(EDITOR_FOCUS_EVENT, { detail }))
}
