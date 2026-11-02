import { getSchema } from '@tiptap/core'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'
import Highlight from '@tiptap/extension-highlight'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { serializeMarkdownAst } from '../../../shared/utils/markdown-rich-text'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { InlineMarkdown, createInlineMarkdownPlugin } from '../../../shared/utils/tiptap-inline-markdown'
import { EditorState as ProseMirrorState } from '@tiptap/pm/state'
import { ResizableMarkdownImage } from '../../../shared/utils/resizable-markdown-image'
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { isolateHistory } from '@codemirror/commands'
import { hasInlineMarkdownSource } from '../../../shared/utils/tiptap-inline-markdown'

const extensions = [StarterKit.configure({ link: { openOnClick: false, autolink: false, linkOnPaste: false,
  isAllowedUri: (url, { defaultValidate }) => !/^[a-z][a-z0-9+.-]*:/i.test(Array.from(url).filter(char => char.charCodeAt(0) > 31 && !/\s/.test(char)).join('')) || defaultValidate(url),
} }),
  ResizableMarkdownImage.configure({ allowBase64: true }), Highlight,
  Table, TableRow, TableHeader, TableCell, TaskList, TaskItem.configure({ nested: true }), InlineMarkdown]
let codec: { manager: MarkdownManager; schema: ReturnType<typeof getSchema> } | undefined
function clipboardCodec() {
  return codec ??= { manager: new MarkdownManager({ extensions }), schema: getSchema(extensions) }
}

/** Ordinary Tiptap uses source-backed inline text, but structural blocks are plain. */
export function continuousClipboardPlainText(source: string) {
  if (/^!\[[\s\S]*\]\([\s\S]*\)(?:\{width=\d+%\})?$/.test(source) && !source.includes('\n')) return source
  const { manager, schema } = clipboardCodec()
  const doc = schema.nodeFromJSON(manager.parse(source))
  return doc.textBetween(0, doc.content.size, '\n', '')
}

/** Parse only inert template contents: never attach clipboard HTML to a live DOM,
 * instantiate an editor, execute scripts, resolve NodeViews, or fetch image URLs.
 * ProseMirror's installed schema + the ordinary Markdown serializer own semantics.
 */
const compactClipboardUri = (value: string) => Array.from(value).filter(char => {
  const code = char.charCodeAt(0)
  return code > 32 && (code < 127 || code > 159)
}).join('')
export function continuousClipboardHtmlToMarkdown(html: string, document: Document): string {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const image of template.content.querySelectorAll('img[src]')) {
    const source = compactClipboardUri(image.getAttribute('src')!)
    if (/^(?:data|blob):/i.test(source)) throw new Error('剪贴板包含内嵌图片，请先将图片导入笔记后再粘贴。')
  }
  template.content.querySelectorAll('script,style,iframe,object,embed,link,meta,base,svg,math,form,input,button,textarea,select,audio,video,source').forEach(element => element.remove())
  for (const element of template.content.querySelectorAll('*')) {
    for (const attribute of Array.from(element.attributes)) {
      const { name, value } = attribute
      if (name === 'style') {
        // These are the only CSS properties used by the ordinary schema's
        // semantic parse rules. Never retain url(), imports or arbitrary CSS.
        const safe = value.split(';').filter(declaration => /^\s*(?:font-weight\s*:\s*(?:bold|normal|[1-9]00)|font-style\s*:\s*(?:italic|normal)|text-decoration\s*:\s*(?:line-through|underline)|text-align\s*:\s*(?:left|center|right))\s*$/i.test(declaration)).join(';')
        if (safe) element.setAttribute(name, safe)
        else element.removeAttribute(name)
      } else if (!/^(?:href|src|alt|title|colspan|rowspan|class|data-type|data-checked)$/.test(name)) element.removeAttribute(name)
      else if (name === 'href' || name === 'src') {
        const compact = compactClipboardUri(value)
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1]?.toLowerCase()
        const safe = !scheme || /^(?:https?|ftp|file|mailto|tel|sms|cid|xmpp)$/.test(scheme)
          || name === 'src' && /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i.test(compact)
        if (!safe) element.removeAttribute(name)
      }
    }
  }
  const { schema, manager } = clipboardCodec()
  const parsed = ProseMirrorDOMParser.fromSchema(schema).parse(template.content)
  // Ordinary paste normalizes applied marks into editable inline source in
  // appendTransaction. Reuse that pure state pipeline (no Editor/View/NodeView).
  const state = ProseMirrorState.create({ schema, plugins: [createInlineMarkdownPlugin()] })
  const normalized = state.applyTransaction(state.tr.replaceWith(0, state.doc.content.size, parsed.content)).state.doc
  return serializeMarkdownAst({ getJSON: () => normalized.toJSON(), markdown: manager })
}

/** Minimal source-backed host contract; the host owns the single view/history. */
export interface ContinuousClipboardView {
  readonly state: EditorState
  dispatch(spec: TransactionSpec): void
  focus(): void
}
export interface ContinuousMarkdownClipboardOptions {
  getView: () => ContinuousClipboardView | null
  readSource: (from: number, to: number) => string
  writeText: (text: string) => Promise<void>
  readClipboard?: () => Promise<ContinuousClipboardPayload>
  isActive?: () => boolean
  isPartial?: () => boolean
  sourceOnly?: () => boolean
  getDocumentIdentity?: () => unknown
  getRevision?: () => unknown
  getSelectionIdentity?: () => unknown
  getDocument?: () => Document
  claimEvent?: (event: ClipboardEvent, action: 'copy' | 'cut' | 'paste') => boolean
  reportError?: (message: string, detail: string) => void
}

export interface ContinuousClipboardPayload { text?: string; html?: string; files?: boolean }

/** A rich selection inside a structural block retains that block in ordinary
 * Tiptap's slice serializer. Read its parsed ancestors, not the whole document. */
function selectionSource(state: EditorState, from: number, to: number, source: string) {
  for (let node = syntaxTree(state).resolveInner(from, 1); node; node = node.parent) {
    if (to > node.to || from <= node.from && to >= node.to) continue
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name)
    if (heading) {
      const prefix = node.name.startsWith('ATX') ? /^[ \t]*#{1,6}[ \t]+/.exec(state.doc.sliceString(node.from, Math.min(node.to, node.from + 4096)))?.[0].length ?? 0 : 0
      const text = source.slice(Math.max(0, node.from + prefix - from))
      return serializeMarkdownAst({ getJSON: () => ({ type: 'doc', content: [{ type: 'heading', attrs: { level: Number(heading[1]) }, content: [{ type: 'text', text }] }] }), markdown: clipboardCodec().manager })
    }
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
      const info = node.getChild('CodeInfo')
      const language = info ? state.doc.sliceString(info.from, info.to).trim().split(/\s+/)[0] : null
      return serializeMarkdownAst({ getJSON: () => ({ type: 'doc', content: [{ type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text: source }] }] }), markdown: clipboardCodec().manager })
    }
  }
  return source
}

export function createContinuousMarkdownClipboard(options: ContinuousMarkdownClipboardOptions) {
  let disposed = false
  let generation = 0
  const current = () => !disposed && options.isActive?.() !== false ? options.getView() : null
  const editable = () => {
    const view = current()
    return !!view && !view.state.readOnly && !options.isPartial?.()
  }
  const capture = () => {
    const view = current()
    if (!view) return null
    const doc = view.state.doc, selection = view.state.selection
    const identity = options.getDocumentIdentity?.(), revision = options.getRevision?.(), token = generation
    const selectionIdentity = options.getSelectionIdentity?.()
    return { view, valid: () => current() === view && generation === token && view.state.doc === doc
      && view.state.selection.eq(selection) && options.getSelectionIdentity?.() === selectionIdentity
      && options.getDocumentIdentity?.() === identity && options.getRevision?.() === revision }
  }
  const payloadText = (source: boolean, overrideText?: string) => {
    const view = current()
    if (!view) return null
    if (overrideText !== undefined) return overrideText
    const ranges = view.state.selection.ranges.filter(range => !range.empty)
    if (!ranges.length) return null
    return ranges.map(({ from, to }) => {
      const text = options.readSource(from, to)
      return options.sourceOnly?.() ? text : source ? selectionSource(view.state, from, to, text) : continuousClipboardPlainText(text)
    }).join('\n')
  }
  const capabilities = (overrideText?: string) => {
    const view = current(), selection = view?.state.selection.main
    const copy = !!view && (overrideText !== undefined || !!selection && !selection.empty)
    let copySource = !!view && overrideText !== undefined
    if (view && selection && !selection.empty && !copySource) {
      syntaxTree(view.state).iterate({ from: selection.from, to: selection.to, enter(node) {
        if (!/^(Document|Paragraph|Escape|Entity)$/.test(node.name)) copySource = true
        return !copySource
      } })
      if (!copySource) copySource = hasInlineMarkdownSource(view.state.doc.sliceString(selection.from, Math.min(selection.to, selection.from + 4096)))
    }
    return { copy, copySource, cut: copy && editable(), paste: editable() }
  }
  const pastePayload = (payload: ContinuousClipboardPayload) => {
    if (!editable() || payload.files) return false
    const owner = options.getDocument?.()
    const text = payload.html && !options.sourceOnly?.() && owner
      ? continuousClipboardHtmlToMarkdown(payload.html, owner) : payload.text
    if (!text) return false
    const view = current()!
    view.dispatch({ ...view.state.replaceSelection(text), annotations: [Transaction.userEvent.of('input.paste'), isolateHistory.of('full')] })
    return true
  }
  const claimed = (event: ClipboardEvent, action: 'copy' | 'cut' | 'paste') => {
    if (!current() || !options.claimEvent?.(event, action)) return false
    event.preventDefault()
    return true
  }
  const nativeCopy = (event: ClipboardEvent, cut: boolean) => {
    if (event.defaultPrevented) return false
    if (claimed(event, cut ? 'cut' : 'copy')) return true
    if (!event.clipboardData || cut && !editable()) return false
    const text = payloadText(false)
    if (text === null) return false
    event.preventDefault()
    try {
      event.clipboardData.setData('text/plain', text)
      if (cut) {
        const view = current()!
        view.dispatch({ ...view.state.replaceSelection(''), annotations: [Transaction.userEvent.of('delete.cut'), isolateHistory.of('full')] })
      }
    } catch (error) {
      options.reportError?.('复制内容失败，原文已保留。', error instanceof Error ? error.message : String(error))
    }
    return true
  }
  return {
    capabilities,
    handleCopy: (event: ClipboardEvent) => nativeCopy(event, false),
    handleCut: (event: ClipboardEvent) => nativeCopy(event, true),
    handlePaste(event: ClipboardEvent) {
      if (event.defaultPrevented) return false
      if (claimed(event, 'paste')) return true
      const data = event.clipboardData
      if (!editable() || !data || data.files.length || Array.from(data.types).some(type => /^(?:Files|image\/|public\.(?:tiff|png|jpeg))/i.test(type))) return false
      const text = data.getData('text/plain'), html = data.getData('text/html')
      if (!text && !html) return false
      event.preventDefault()
      try { pastePayload({ text, html }) }
      catch (error) { options.reportError?.('粘贴内容失败，原文已保留。', error instanceof Error ? error.message : String(error)) }
      return true
    },
    async cut() {
      if (!editable()) return false
      const snapshot = capture()!, text = payloadText(false)
      if (text === null) return false
      await options.writeText(text)
      if (!snapshot.valid() || !editable()) return false
      snapshot.view.dispatch({ ...snapshot.view.state.replaceSelection(''), annotations: [Transaction.userEvent.of('delete.cut'), isolateHistory.of('full')] })
      return true
    },
    pastePayload,
    async paste(read = options.readClipboard, apply = pastePayload) {
      if (!editable() || !read) return false
      const snapshot = capture()!
      const payload = await read()
      return snapshot.valid() && apply(payload)
    },
    invalidate() { generation++ },
    destroy() { disposed = true; generation++ },
    async copy(overrideText?: string) {
      const text = payloadText(false, overrideText)
      if (text === null) return false
      await options.writeText(text)
      return true
    },
    async copySource(overrideText?: string) {
      const text = payloadText(true, overrideText)
      if (text === null) return false
      await options.writeText(text)
      return true
    },
  }
}
