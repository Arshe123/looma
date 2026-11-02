import { syntaxTree } from '@codemirror/language'
import { EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import type { RootContent } from 'hast'
import type { SyntaxNode } from '@lezer/common'
import { common, createLowlight } from 'lowlight'
import { getContinuousEmptyInlineSource } from './continuousMarkdownSyntax'
import { h, render } from 'vue'
import CodeBlockCopy from '../shared/CodeBlockCopy.vue'
import '../shared/code-block-presentation.css'

type SourceRange = { from: number; to: number }
export type ContinuousCodeBlock = SourceRange & {
  info: SourceRange | null
  language: string
  opening: SourceRange | null
  closing: SourceRange | null
  content: SourceRange
}
const lowlight = createLowlight(common)
const WINDOW = 4096
const BUDGET = 32768

function describeBlock(state: EditorState, node: SyntaxNode): ContinuousCodeBlock {
  const first = node.firstChild
  const opening = node.name === 'FencedCode' && first?.name === 'CodeMark' ? { from: first.from, to: first.to } : null
  const infoNode = opening && first?.nextSibling?.name === 'CodeInfo' ? first.nextSibling : null
  const info = infoNode ? { from: infoNode.from, to: infoNode.to } : null
  const last = node.lastChild
  const closing = opening && last?.name === 'CodeMark' && last.from !== opening.from ? { from: last.from, to: last.to } : null
  const from = opening ? Math.min(state.doc.length, state.doc.lineAt(opening.from).to + 1) : node.from
  return {
    from: node.from, to: node.to, opening, closing, info,
    language: info ? state.sliceDoc(info.from, Math.min(info.to, info.from + 256)).split(/\s/, 1)[0] : '',
    content: { from: Math.min(from, node.to), to: closing ? state.doc.lineAt(closing.from).from : node.to },
  }
}

function highlight(source: string, language: string, offset: number) {
  const marks: (SourceRange & { className: string })[] = []
  if (language && !lowlight.registered(language)) return marks
  let position = offset
  const visit = (nodes: RootContent[], inherited: string[] = []) => {
    for (const node of nodes) {
      const own = node.type === 'element' ? node.properties.className : null
      const classes = [...inherited, ...(Array.isArray(own) ? own.filter((value): value is string => typeof value === 'string') : [])]
      if (node.type === 'element') visit(node.children, classes)
      else if (node.type === 'text') {
        const to = position + node.value.length
        if (to > position && classes.length) marks.push({ from: position, to, className: classes.join(' ') })
        position = to
      }
    }
  }
  try { visit((language ? lowlight.highlight(language, source) : lowlight.highlightAuto(source)).children) } catch { /* Unknown or invalid code stays literal. */ }
  return marks
}

type CodeView = { state: EditorState; dispatch: (spec: TransactionSpec) => void }

function fencedBlockAt(state: EditorState, position: number) {
  if (position < 0 || position > state.doc.length) return null
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, 1)
  while (node && node.name !== 'FencedCode') node = node.parent
  if (!node) return null
  const block = describeBlock(state, node)
  return block.opening?.from === position ? block : null
}

/** Uses the host view's dispatch, so its source model and history own this edit. */
export function changeContinuousCodeLanguage(view: CodeView, position: number, language: string) {
  if (view.state.readOnly || !/^[a-zA-Z0-9_+-]+$/.test(language)
    || (language !== 'text' && !lowlight.registered(language))) return false
  const block = fencedBlockAt(view.state, position)
  if (!block?.opening || block.language === language) return false
  const from = block.info?.from ?? block.opening.to
  // Explicit edits may inspect the complete info token; viewport planning never does.
  const token = block.info ? view.state.sliceDoc(block.info.from, block.info.to).split(/\s/, 1)[0] : ''
  view.dispatch({ changes: { from, to: from + token.length, insert: language }, userEvent: 'input.codeLanguage' })
  return true
}

/** Full block reads happen only for an explicit copy action, never during presentation. */
export function readContinuousCodeContent(state: EditorState, position: number): string | null {
  const block = fencedBlockAt(state, position)
  if (!block) return null
  const parts: string[] = []
  syntaxTree(state).iterate({ from: block.content.from, to: block.content.to, enter(ref) {
    if (ref.name === 'CodeText') {
      parts.push(state.sliceDoc(ref.from, ref.to))
      return false
    }
  } })
  if (block.closing && block.content.to > block.content.from) parts.push('\n')
  return parts.join('')
}

/** No parse forcing, full-document strings, or work proportional to a code block's length. */
export function buildContinuousCodePlan(state: EditorState, ranges: readonly SourceRange[]) {
  const blocks = new Map<number, ContinuousCodeBlock>()
  const marks: (SourceRange & { className: string })[] = []
  const seen = new Set<string>()
  let scanned = 0
  const tree = syntaxTree(state)
  for (const range of ranges) {
    tree.iterate({ from: range.from, to: range.to, enter(ref) {
      if (ref.name === 'FencedCode' || ref.name === 'CodeBlock') {
        if (!blocks.has(ref.from)) blocks.set(ref.from, describeBlock(state, ref.node))
      }
      if (ref.name !== 'CodeText') return
      const parent = ref.node.parent
      if (!parent || (parent.name !== 'FencedCode' && parent.name !== 'CodeBlock')) return
      const block = blocks.get(parent.from) || describeBlock(state, parent)
      const from = Math.max(ref.from, range.from), to = Math.min(ref.to, range.to)
      for (let at = from; at < to && scanned < BUDGET;) {
        const end = Math.min(to, at + WINDOW, at + BUDGET - scanned)
        const key = `${at}:${end}`
        if (!seen.has(key)) {
          seen.add(key)
          const source = state.sliceDoc(at, end)
          scanned += source.length
          marks.push(...highlight(source, block.language, at))
        }
        at = end
      }
      return false
    } })
  }
  return { blocks: [...blocks.values()], marks, scanned }
}

class CodeLineNumber extends WidgetType {
  constructor(readonly number: number) { super() }
  eq(other: CodeLineNumber) { return this.number === other.number }
  toDOM(view: EditorView) {
    const number = view.dom.ownerDocument.createElement('span')
    number.className = 'looma-line-number looma-continuous-code-line-number'
    number.contentEditable = 'false'
    number.setAttribute('data-line', String(this.number))
    number.setAttribute('aria-hidden', 'true')
    number.textContent = String(this.number)
    return number
  }
  ignoreEvent() { return true }
}

// Equal widgets can inherit an older instance's DOM; ownership follows the DOM.
const codeToolbarHosts = new WeakMap<HTMLElement, HTMLElement>()
class CodeToolbar extends WidgetType {
  constructor(readonly position: number, readonly language: string, readonly readOnly: boolean) { super() }
  eq(other: CodeToolbar) {
    return this.position === other.position && this.language === other.language && this.readOnly === other.readOnly
  }
  toDOM(view: EditorView) {
    const doc = view.dom.ownerDocument
    const root = doc.createElement('span')
    root.className = 'looma-continuous-code-toolbar'
    root.contentEditable = 'false'
    root.setAttribute('role', 'group')
    root.setAttribute('aria-label', '代码块工具栏')
    const label = doc.createElement('label')
    label.textContent = '语言：'
    label.hidden = true
    root.title = '点击复制代码；右键或 Shift+F10 选择代码语言'
    const select = doc.createElement('select')
    select.setAttribute('aria-label', '代码语言')
    select.disabled = this.readOnly
    const languages = [...new Set(['text', ...lowlight.listLanguages(), ...(this.language ? [this.language] : [])])]
    for (const language of languages) {
      const option = doc.createElement('option')
      option.value = language
      option.textContent = language === 'text' ? '纯文本' : language
      select.appendChild(option)
    }
    select.value = this.language || 'text'
    // Resolve from the live widget DOM, never from stale document offsets.
    const position = () => view.posAtDOM(root)
    select.addEventListener('change', () => {
      if (!changeContinuousCodeLanguage(view, position(), select.value)) select.value = this.language || 'text'
    })
    const disclose = (event: Event) => {
      event.preventDefault()
      event.stopPropagation()
      label.hidden = false
      select.focus?.()
    }
    root.addEventListener('mouseover', event => updateContinuousCodeHover(view, event.target as Element | null))
    root.addEventListener('mouseout', event => updateContinuousCodeHover(view, event.relatedTarget as Element | null))
    root.addEventListener('contextmenu', disclose)
    root.addEventListener('keydown', event => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) disclose(event)
      else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        label.hidden = true
        root.querySelector<HTMLButtonElement>('button')?.focus()
      }
    })
    root.addEventListener('focusout', event => {
      if (!root.contains(event.relatedTarget as Node | null)) label.hidden = true
    })
    select.addEventListener('change', () => { label.hidden = true })
    label.appendChild(select)
    const copy = doc.createElement('span')
    copy.className = 'code-block-copy-host'
    codeToolbarHosts.set(root, copy)
    // Vue render flushes unrelated pre-flush watchers, which may dispatch to
    // this editor. Never run it inside CodeMirror's synchronous DOM update.
    queueMicrotask(() => {
      if (codeToolbarHosts.get(root) !== copy) return
      render(h(CodeBlockCopy, {
        language: this.language,
        getText: () => readContinuousCodeContent(view.state, position()),
      }), copy)
    })
    root.append(label, copy)
    return root
  }
  destroy(dom: HTMLElement) {
    const host = codeToolbarHosts.get(dom)
    codeToolbarHosts.delete(dom)
    if (host) queueMicrotask(() => render(null, host))
  }
  ignoreEvent() { return true }
}

/** Inline marks and same-line fence replacements only. No code content is replaced. */
export function buildContinuousCodeDecorations(state: EditorState, ranges: readonly SourceRange[], focused = true): DecorationSet {
  const plan = buildContinuousCodePlan(state, ranges)
  const pending = focused ? getContinuousEmptyInlineSource(state.doc, state.selection.main) : null
  const decorations = plan.marks.map(mark => Decoration.mark({ class: `looma-continuous-code-token ${mark.className}` }).range(mark.from, mark.to))
  const visible = (range: SourceRange) => ranges.some(window => window.from <= range.from && window.to >= range.to)
  const styledLines = new Set<number>()
  for (const block of plan.blocks) {
    // Indented blocks have no opening fence. Two absent offsets must not
    // suppress their native line shell as though they were a pending fence.
    if (block.opening && pending && block.opening.from === pending.from) continue
    const first = state.doc.lineAt(block.from).number
    const last = state.doc.lineAt(block.to).number
    for (const range of ranges) {
      const from = Math.max(first, state.doc.lineAt(range.from).number)
      const to = Math.min(last, state.doc.lineAt(range.to).number)
      for (let number = from; number <= to && styledLines.size < 2048; number++) {
        if (styledLines.has(number)) continue
        styledLines.add(number)
        const classes = 'looma-code-line looma-continuous-code-block'
          + (number === first ? ' looma-code-block-start' : '')
          + (number === last ? ' looma-code-block-end' : '')
          + (number === first && block.opening && (!block.info || block.info.to - block.opening.from <= 512) ? ' looma-code-fence-start' : '')
          + (number === last && block.closing ? ' looma-code-fence-end' : '')
        const line = state.doc.line(number)
        decorations.push(Decoration.line({ class: classes, attributes: { 'data-code-line': String(number), 'data-code-block': String(block.from) } }).range(line.from))
        if ((!block.opening || number > first) && (!block.closing || number < last)) {
          decorations.push(Decoration.widget({ widget: new CodeLineNumber(number), side: -1 }).range(line.from))
        }
      }
    }
    if (block.opening && visible(block.opening)) {
      // A pathological info line must not cause an enormous replacement or read.
      const end = block.info && block.info.to - block.opening.from <= 512 ? block.info.to : block.opening.to
      decorations.push(Decoration.replace({ widget: new CodeToolbar(block.opening.from, block.language, state.readOnly) }).range(block.opening.from, end))
    }
    if (block.closing && visible(block.closing)) decorations.push(Decoration.replace({}).range(block.closing.from, block.closing.to))
  }
  return Decoration.set(decorations, true)
}

/** Hover follows block identity across native sibling lines, not the entire editor. */
export function updateContinuousCodeHover(view: EditorView, target: Element | null) {
  const line = target && view.dom.contains(target) ? target.closest('.looma-code-line') : null
  const block = line?.getAttribute('data-code-block')
  for (const toolbar of view.dom.querySelectorAll<HTMLElement>('.looma-continuous-code-toolbar')) {
    toolbar.classList.toggle('is-block-hovered', block != null && toolbar.closest('.looma-code-line')?.getAttribute('data-code-block') === block)
  }
}

/** Host supplies markdown(); one native EditorView and the host's existing history remain authoritative. */
export function continuousMarkdownCode(): Extension {
  return [ViewPlugin.fromClass(class {
    decorations: DecorationSet
    pending: number | undefined
    constructor(view: EditorView) {
      this.pending = view.hasFocus ? getContinuousEmptyInlineSource(view.state.doc, view.state.selection.main)?.from : undefined
      this.decorations = buildContinuousCodeDecorations(view.state, view.visibleRanges, view.hasFocus)
    }
    update(update: import('@codemirror/view').ViewUpdate) {
      const pending = update.view.hasFocus ? getContinuousEmptyInlineSource(update.state.doc, update.state.selection.main)?.from : undefined
      if (update.docChanged || update.viewportChanged || update.startState.readOnly !== update.state.readOnly
        || this.pending !== pending || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.pending = pending
        this.decorations = buildContinuousCodeDecorations(update.state, update.view.visibleRanges, update.view.hasFocus)
      }
    }
  }, { decorations: plugin => plugin.decorations }), EditorView.domEventHandlers({
    mouseover(event, view) { updateContinuousCodeHover(view, event.target as Element | null) },
    mouseout(event, view) { updateContinuousCodeHover(view, event.relatedTarget as Element | null) },
  })]
}
