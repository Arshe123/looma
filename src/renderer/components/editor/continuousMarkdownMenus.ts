import { h, render } from 'vue'

import ContextMenuPresentation from '../preview/menus/ContextMenuPresentation.vue'
import QuickMenuPresentation from '../preview/menus/QuickMenuPresentation.vue'
import TableToolbarPresentation from '../preview/menus/TableToolbarPresentation.vue'
import { continuousToolbarTableSize, resizeContinuousToolbarTable } from './continuousMarkdownMenuTable'
import { getContinuousTableContext } from './continuousMarkdownTable'
import MenuPlusButton from '../preview/menus/MenuPlusButton.vue'
import { contextClipboardItems, nextMenuIndex, type MenuPresentationItem } from '../preview/menus/menuPresentation'
import TableSizePicker from '../preview/TableSizePicker.vue'
import { EditorState, StateEffect, type Extension } from '@codemirror/state'
import { syntaxTree, syntaxTreeAvailable } from '@codemirror/language'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { matchesAppShortcut, type AppShortcutSettings } from '../../../shared/utils/app-shortcuts'
import { formatEditorShortcut, matchesEditorShortcut, type EditorShortcutEvent, type EditorShortcutSettings } from '../../../shared/utils/editor-shortcuts'
import { getMenuAction, getTableMenuActions } from '../../../shared/utils/tiptap-menu-actions'
import { parseNoteLinkHref } from '../../../shared/utils/note-link-ref'

export interface ContinuousMarkdownMenusOptions {
  inlineItems: () => readonly string[]
  shortcuts: () => EditorShortcutSettings
  appShortcuts: () => AppShortcutSettings
  platform: string
  runAction: (view: EditorView, id: string) => boolean
  insertTable: (view: EditorView, rows: number, columns: number) => boolean
  canRunAction?: (id: string) => boolean
  hasTableSelection?: (state: EditorState) => boolean
  clipboard?: (action: 'copy' | 'copy-source' | 'paste', range?: { from: number; to: number }) => boolean | Promise<boolean>
}

export type ContinuousMenuSourceTarget = {
  kind: 'link' | 'image'
  from: number
  to: number
  destination: { from: number; to: number } | null
}

export type ContinuousMenuContext = {
  blank: boolean
  table: boolean
  copySource: boolean
  target: ContinuousMenuSourceTarget | null
}

/** Read parsed ancestors only; no parsing, document flattening, or serialization. */
export function getContinuousMenuContext(state: EditorState, position = state.selection.main.head, inspectSelection = true): ContinuousMenuContext {
  const tree = syntaxTree(state)
  const line = state.doc.lineAt(position)
  let literal = false
  let table = false
  let target: ContinuousMenuSourceTarget | null = null
  for (const side of [1, -1] as const) {
    for (let node = tree.resolveInner(position, side); node; node = node.parent) {
      if (/^(FencedCode|CodeBlock|InlineCode|HTMLBlock|CommentBlock)$/.test(node.name)) literal = true
      if (node.name === 'Table') table = true
      if (!target && (node.name === 'Link' || node.name === 'Image') && position >= node.from && position < node.to) {
        const url = node.getChild('URL')
        const width = node.name === 'Image' ? /^\{width=(\d{1,3})%\}/.exec(state.doc.sliceString(node.to, Math.min(state.doc.length, node.to + 16))) : null
        const to = width && Number(width[1]) >= 10 && Number(width[1]) <= 100 ? node.to + width[0].length : node.to
        target = { kind: node.name === 'Image' ? 'image' : 'link', from: node.from, to,
          destination: url ? { from: url.from, to: url.to } : null }
      }
    }
  }
  const selection = state.selection.main
  let copySource = false
  if (inspectSelection && !selection.empty) {
    // A conservative bounded eligibility query; actual source is read only on copy.
    tree.iterate({ from: selection.from, to: Math.min(selection.to, selection.from + 4096), enter(node) {
      if (/^(StrongEmphasis|Emphasis|Strikethrough|InlineCode|Link|Image|ATXHeading[1-6]|SetextHeading[1-6]|BulletList|OrderedList|Blockquote|FencedCode|Table|HorizontalRule)$/.test(node.name)) copySource = true
    } })
    // Highlight is a display extension, not part of Lezer's Markdown grammar.
    // Inspect only a bounded prefix when the context menu explicitly requests
    // source-copy eligibility; scroll/geometry queries skip this branch.
    if (!copySource) copySource = /(?:^|[^\\])==(?=\S)[^\n]*?\S==/.test(state.doc.sliceString(selection.from, Math.min(selection.to, selection.from + 4096)))
  }
  return {
    blank: !state.readOnly && selection.empty && !literal && !table && syntaxTreeAvailable(state, line.to)
      && line.length <= 4096 && /^[ \t]*$/.test(state.doc.sliceString(line.from, line.to)),
    table: !literal && table,
    copySource,
    target: literal ? null : target,
  }
}

export function continuousMenuPosition(rect: { left: number; top: number; width: number; height: number }, size = 24) {
  return { left: rect.left + (rect.width - size) / 2, top: rect.top + (rect.height - size) / 2 }
}

/** Dispatch after persisted menu/shortcut settings change (not a history edit). */
export const refreshContinuousMarkdownMenus = StateEffect.define<null>()

/** Slot indexes intentionally refer to the unfiltered user configuration. */
export function resolveContinuousMenuShortcut(
  event: EditorShortcutEvent,
  items: readonly string[],
  shortcuts: EditorShortcutSettings,
  appShortcuts: AppShortcutSettings,
  platform: string,
): string | null {
  if (matchesAppShortcut(event, appShortcuts.openInlineMenu, platform)) return 'openInlineMenu'
  for (let index = 0; index < 9; index++) {
    const binding = shortcuts.inlineMenuSlots[index]
    if (binding && (binding.ctrl || binding.alt || binding.meta) && getMenuAction(items[index])
      && matchesEditorShortcut(event, binding, platform)) return items[index]
  }
  return null
}

export function getContinuousContextSelection(state: EditorState, position: number) {
  const selection = state.selection.main
  if (!selection.empty) return { anchor: selection.anchor, head: selection.head }
  const target = getContinuousMenuContext(state, position).target
  return target ? { anchor: target.from, head: target.to } : { anchor: position, head: position }
}

export function continuousTableMenuItems(): { id: string; label: string }[] {
  return getTableMenuActions().map(({ id, label }) => ({ id, label }))
}

type MenuItem = MenuPresentationItem & { activate: () => void }
type Point = { left: number; top: number }

/** One view, one source/history. All panels are disposable DOM, never editor instances. */
export function continuousMarkdownMenus(options: ContinuousMarkdownMenusOptions): Extension {
  const plugin = ViewPlugin.fromClass(class {
    readonly doc: Document
    readonly win: Window
    readonly root: HTMLDivElement
    plus: HTMLButtonElement
    table!: HTMLElement
    private tableHost: HTMLDivElement
    private sizePickerVisible = false
    readonly panel: HTMLDivElement
    private status: HTMLElement | null = null
    private plusHost: HTMLDivElement
    private observer: ResizeObserver | null = null
    private hiddenNumber: { element: HTMLElement; visibility: string } | null = null
    private disposed = false
    private dragging = false
    private composing = false
    private panelOpen = false
    private panelGeneration = 0
    private fixedAnchor: Point | null = null
    private buttons: HTMLButtonElement[] = []
    private selected = 0
    private forwardingPreviewClose = false

    constructor(readonly view: EditorView) {
      this.doc = view.dom.ownerDocument
      this.win = this.doc.defaultView!
      this.root = this.doc.createElement('div')
      this.root.className = 'looma-continuous-menu-root'
      this.root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1000;font-family:var(--font-ui)'
      this.plusHost = this.doc.createElement('div')
      this.root.append(this.plusHost)
      this.plus = this.doc.createElement('button')
      this.plus.hidden = true
      this.table = this.doc.createElement('div')
      this.table.hidden = true
      // Vue render flushes global pre-flush watchers; defer all mounts away
      // from CodeMirror's construction/update/destruction transactions.
      queueMicrotask(() => {
        if (this.disposed) return
        render(h(MenuPlusButton, {
          class: 'fixed pointer-events-auto', hidden: true,
          'data-looma-continuous-menu-plus': '',
          onPointerdown: (event: PointerEvent) => event.preventDefault(),
          onClick: () => { if (this.editable()) this.openQuick(false, this.plus) },
        }), this.plusHost)
        this.plus = this.plusHost.firstElementChild as HTMLButtonElement
        this.measure()
      })
      this.tableHost = this.doc.createElement('div')
      this.root.append(this.tableHost)
      this.renderToolbar()
      this.panel = this.doc.createElement('div')
      this.panel.className = 'looma-continuous-menu-panel fixed pointer-events-auto'
      this.panel.style.cssText = 'max-width:calc(100vw - 16px);max-height:calc(100vh - 16px)'
      this.panel.setAttribute('role', 'menu')
      this.panel.setAttribute('aria-label', '编辑菜单')
      this.panel.hidden = true
      this.panel.addEventListener('pointerdown', event => {
        if (!(event.target as Element).closest('input')) event.preventDefault()
      })
      this.root.append(this.panel)
      this.doc.body.append(this.root)
      view.dom.addEventListener('contextmenu', this.contextDOM, true)
      this.doc.addEventListener('pointerdown', this.outside, true)
      this.doc.addEventListener('pointerup', this.release, true)
      this.doc.addEventListener('pointercancel', this.release, true)
      this.doc.addEventListener('dragend', this.release, true)
      this.doc.addEventListener('drop', this.release, true)
      this.doc.addEventListener('keydown', this.panelKey, true)
      this.win.addEventListener('scroll', this.scrolled, true)
      this.win.addEventListener('resize', this.geometryChanged)
      this.win.addEventListener('blur', this.blurred)
      this.win.visualViewport?.addEventListener('resize', this.geometryChanged)
      this.win.visualViewport?.addEventListener('scroll', this.geometryChanged)
      if (typeof ResizeObserver !== 'undefined') {
        this.observer = new ResizeObserver(this.geometryChanged)
        // Include unclamped pane ancestors: the reading column can stay 800px
        // wide while a split resize moves its gutter horizontally.
        for (let element: HTMLElement | null = view.dom; element && element !== this.doc.body; element = element.parentElement) this.observer.observe(element)
      }
      this.measure()
    }

    private renderToolbar() {
      queueMicrotask(() => {
      if (this.disposed) return
      const previous = this.table
      const size = continuousToolbarTableSize(this.view.state) ?? { rows: 3, cols: 3 }
      render(h(TableToolbarPresentation, {
        style: { position: 'fixed', pointerEvents: 'auto', left: previous?.style.left, top: previous?.style.top },
        hidden: previous?.hidden ?? true,
        sizePickerVisible: this.sizePickerVisible, currentTableSize: size,
        onPointerdown: (event: PointerEvent) => { if (!(event.target as Element).closest('input')) event.preventDefault() },
        onSize: () => {
          if (!this.editable()) return
          this.sizePickerVisible = !this.sizePickerVisible
          this.renderToolbar()
        },
        onCopy: () => {
          const context = getContinuousTableContext(this.view.state)
          if (context) void this.clipboard('copy', context)
        },
        onDelete: () => { this.action('deleteTable') },
        onResize: (size: { rows: number; cols: number }) => {
          if (!this.editable()) return
          if (resizeContinuousToolbarTable(this.view, size.rows, size.cols)) {
            this.close(); this.view.focus(); this.measure()
          } else this.fail('当前位置无法调整表格大小')
        },
      }), this.tableHost)
      this.table = this.tableHost.firstElementChild as HTMLElement
      this.measure()
      })
    }

    private editable() {
      return !this.disposed && !this.view.state.readOnly && this.view.state.facet(EditorView.editable) && !this.composing && !this.view.composing && !this.dragging
    }

    private restoreNumber() {
      if (this.hiddenNumber) this.hiddenNumber.element.style.visibility = this.hiddenNumber.visibility
      this.hiddenNumber = null
    }

    private hideAnchors() {
      this.restoreNumber()
      this.plus.hidden = this.table.hidden = true
    }

    private close = () => {
      if (this.sizePickerVisible) { this.sizePickerVisible = false; this.renderToolbar() }
      const generation = this.panelGeneration
      if (this.panelOpen) queueMicrotask(() => {
        if (generation === this.panelGeneration && !this.panelOpen) render(null, this.panel)
      })
      this.status = null
      this.panelOpen = false
      this.panel.hidden = true
      this.panel.removeAttribute('data-looma-editor-context-menu')
      this.plus.setAttribute('aria-expanded', 'false')
      this.table.setAttribute('aria-expanded', 'false')
      this.fixedAnchor = null
      this.buttons = []
    }

    private outside = (event: PointerEvent) => {
      if (this.root.contains(event.target as Node)) return
      this.close()
      if (event.button === 0 && this.view.contentDOM.contains(event.target as Node)) {
        this.dragging = true
        this.hideAnchors()
      } else if (!this.view.dom.contains(event.target as Node)) this.hideAnchors()
    }

    private release = () => { this.dragging = false; this.measure() }
    private blurred = () => { this.dragging = false; this.close(); this.hideAnchors() }
    private scrolled = (event: Event) => {
      if (this.panel.contains(event.target as Node)) return
      this.close()
      this.hideAnchors()
      this.measure()
    }
    private geometryChanged = () => { this.close(); this.hideAnchors(); this.measure() }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.geometryChanged || update.viewportChanged || update.state.readOnly !== update.startState.readOnly
        || (update.focusChanged && !update.view.hasFocus && !this.table.contains(this.doc.activeElement))
        || update.transactions.some(tr => tr.effects.some(effect => effect.is(refreshContinuousMarkdownMenus)))) this.close()
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged || update.focusChanged
        || update.transactions.length) this.measure()
    }

    private measure() {
      if (this.disposed) return
      this.view.requestMeasure({ key: this, read: view => {
        if (this.disposed) return null
        const context = getContinuousMenuContext(view.state, view.state.selection.main.head, false)
        const coords = view.coordsAtPos(view.state.selection.main.head)
        const bounds = view.scrollDOM.getBoundingClientRect()
        const visible = !!coords && coords.bottom > bounds.top && coords.top < bounds.bottom
          && coords.left < bounds.right && coords.right >= bounds.left
        let number: HTMLElement | null = null
        let plus: Point | null = null
        if (visible && context.blank && this.editable() && view.hasFocus && options.inlineItems().some(id => getMenuAction(id))) {
          const gutter = view.dom.querySelector<HTMLElement>('.cm-gutter.cm-lineNumbers')
          const centerY = (coords!.top + coords!.bottom) / 2
          if (gutter) {
            for (const element of gutter.querySelectorAll<HTMLElement>('.cm-gutterElement')) {
              const rect = element.getBoundingClientRect()
              if (rect.height && rect.width && centerY >= rect.top && centerY <= rect.bottom) {
                number = element
                plus = continuousMenuPosition(rect)
                break
              }
            }
            // Never invent a fixed left gutter when anchors are unavailable.
            const rect = gutter.getBoundingClientRect()
            if (!plus && rect.width) plus = continuousMenuPosition({ left: rect.left, width: rect.width, top: coords!.top, height: coords!.bottom - coords!.top })
          }
        }
        const tableContext = context.table ? getContinuousTableContext(view.state) : null
        // The first pipe is zero-width editable syntax, not a visual anchor.
        // Use the rendered source row so the toolbar cannot cover its cells.
        const tableRow = tableContext ? view.contentDOM.querySelector<HTMLElement>(`.looma-continuous-table-row[data-line="${view.state.doc.lineAt(tableContext.from).number}"]`) : null
        const tableCoords = tableRow?.getBoundingClientRect() ?? (tableContext ? view.coordsAtPos(tableContext.from) : null)
        const table = visible && context.table && this.editable() && (view.hasFocus || this.sizePickerVisible)
          ? { left: tableCoords?.left ?? coords!.left, top: (tableCoords?.top ?? coords!.top) - 38 } : null
        const anchor = this.fixedAnchor ?? (coords ? { left: coords.left, top: coords.bottom + 4 } : null)
        const panelRect = this.panelOpen ? this.panel.getBoundingClientRect() : null
        return { number, plus, table, anchor, panelRect, width: this.win.innerWidth, height: this.win.innerHeight }
      }, write: result => {
        if (!result || this.disposed) return
        this.restoreNumber()
        this.plus.hidden = !result.plus
        this.table.hidden = !result.table || this.panelOpen
        if (result.plus) {
          this.place(this.plus, result.plus)
          if (result.number) {
            this.hiddenNumber = { element: result.number, visibility: result.number.style.visibility }
            result.number.style.visibility = 'hidden'
          }
        }
        if (result.table) this.place(this.table, { left: Math.max(8, Math.min(result.table.left, result.width - 110)), top: Math.max(8, Math.min(result.table.top, result.height - 32)) })
        if (this.panelOpen && !result.anchor) this.close()
        if (this.panelOpen && result.anchor && result.panelRect) this.place(this.panel, {
          left: Math.max(8, Math.min(result.anchor.left, result.width - result.panelRect.width - 8)),
          top: Math.max(8, Math.min(result.anchor.top, result.height - result.panelRect.height - 8)),
        })
      } })
    }

    private place(element: HTMLElement, point: Point) {
      element.style.left = `${point.left}px`
      element.style.top = `${point.top}px`
    }

    private displayItem(item: MenuPresentationItem): MenuPresentationItem {
      const known = getMenuAction(item.id) ?? getTableMenuActions().find(action => action.id === item.id)
      return { ...item, icon: item.icon ?? known?.icon }
    }

    private show(items: MenuItem[], anchor: Point | null = null, context = false, table = false, picker = false) {
      this.close()
      this.panelGeneration++
      this.fixedAnchor = anchor
      this.panelOpen = true
      if (context) this.panel.dataset.loomaEditorContextMenu = ''
      const onAction = (id: string) => {
        const item = items.find(item => item.id === id)
        if (item) { if (!item.disabled) item.activate() }
        else this.action(id)
      }
      const onTableSize = (size: { rows: number; cols: number }) => {
        if (!this.editable()) return
        if (options.insertTable(this.view, size.rows, size.cols)) { this.close(); this.view.focus(); this.measure() }
        else this.fail('当前位置无法插入表格')
      }
      const display = items.map(item => this.displayItem(item))
      const styleItem = (id: string): MenuPresentationItem => {
        const action = getMenuAction(id)!
        return { id, label: action.label, icon: action.icon, disabled: !this.editable() || options.canRunAction?.(id) === false }
      }
      const node = picker ? h(TableSizePicker, { onSelect: onTableSize }) : context ? h(ContextMenuPresentation, {
        mode: table ? 'table' : 'default',
        textStyleIcons: ['bold', 'italic', 'strike', 'inlineCode', 'highlight'].map(styleItem),
        blockStyleIcons: ['blockquote', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'image', 'table'].map(styleItem),
        listItems: [{ ...styleItem('paragraph'), label: '段落', children: ['paragraph', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(styleItem) }, styleItem('horizontalRule')],
        tableItems: continuousTableMenuItems().map(item => this.displayItem({ ...item, disabled: !this.editable() })),
        clipboardItems: display.filter(item => !continuousTableMenuItems().some(table => table.id === item.id)),
        onAction, onTableSize,
      }, { default: () => h('div', { role: 'status', class: 'px-3 text-xs text-text-subtle', ref: element => { this.status = element as HTMLElement | null } }) })
        : h(QuickMenuPresentation, { items: display, selectedIndex: -1, onAction, onTableSize,
          onHover: (index: number) => { this.selected = index; this.highlight() },
        }, { default: () => h('div', { role: 'status', class: 'px-3 text-xs text-text-subtle', ref: element => { this.status = element as HTMLElement | null } }) })
      render(node, this.panel)
      this.buttons = Array.from(this.panel.querySelectorAll<HTMLButtonElement>('button[data-action], button[data-rows]'))
      this.selected = Math.max(0, this.buttons.findIndex(button => !button.disabled))
      this.panel.hidden = false
      this.highlight(false)
      this.plus.setAttribute('aria-expanded', 'true')
      this.table.setAttribute('aria-expanded', 'true')
      this.measure()
    }

    private highlight(scroll = true) {
      this.buttons.forEach((button, index) => {
        button.toggleAttribute('data-active', index === this.selected)
        button.classList.toggle('bg-accent-soft', index === this.selected)
        button.classList.toggle('text-accent', index === this.selected)
        if (scroll && index === this.selected) button.scrollIntoView({ block: 'nearest' })
      })
    }

    private fail(message: string) {
      if (!this.disposed && this.panelOpen && this.status) { this.status.textContent = message; this.status.setAttribute('role', 'alert') }
    }

    private action(id: string): boolean {
      if (!this.editable()) return false
      if (options.canRunAction?.(id) === false) return false
      if (id === 'table') { this.tablePicker(); return true }
      const handled = options.runAction(this.view, id)
      if (handled) { this.close(); this.view.focus(); this.measure() }
      else this.fail('当前位置无法执行此操作')
      return handled
    }

    private openQuick(table: boolean, button?: HTMLElement): boolean {
      if (!this.editable()) return false
      const items = table ? continuousTableMenuItems() : options.inlineItems().flatMap(id => {
        const action = getMenuAction(id)
        const index = options.inlineItems().indexOf(id), binding = options.shortcuts().inlineMenuSlots[index]
        return action ? [{ id, label: action.label, disabled: options.canRunAction?.(id) === false,
          shortcut: index < 9 && binding?.enabled ? formatEditorShortcut(binding, options.platform) : undefined }] : []
      })
      if (!items.length) return false
      const rect = button?.getBoundingClientRect()
      this.show(items.map(item => ({ ...item, activate: () => { this.action(item.id) } })), rect ? { left: rect.left, top: rect.bottom + 4 } : null)
      return true
    }

    private tablePicker() {
      this.show([], this.fixedAnchor, false, false, true)
      this.panel.setAttribute('aria-label', '选择表格大小')
      this.selected = 0
      this.highlightGrid()
    }

    private highlightGrid() {
      this.buttons[this.selected]?.dispatchEvent(new MouseEvent('mouseenter'))
      this.highlight()
    }

    private panelKey = (event: KeyboardEvent) => {
      if (!this.panelOpen || this.composing || this.view.composing || event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); this.measure(); return }
      if (!this.view.hasFocus && !this.root.contains(event.target as Node)) return
      if (event.key === 'Tab') { this.close(); return }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if ((event.target as Element)?.closest?.('input')) return
      this.buttons = Array.from(this.panel.querySelectorAll<HTMLButtonElement>('button[data-action], button[data-rows]'))
      const grid = this.buttons[0]?.dataset.rows !== undefined
      if (['ArrowDown', 'ArrowUp', ...(grid ? ['ArrowLeft', 'ArrowRight'] : []), 'Home', 'End', 'Enter'].includes(event.key)) {
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Enter') { this.buttons[this.selected]?.click(); return }
        if (!this.buttons.length) return
        const columns = grid ? Number(this.buttons[0]?.dataset.gridColumns) || 10 : 1
        this.selected = nextMenuIndex(this.buttons, this.selected, event.key, columns)
        if (grid) this.highlightGrid()
        else this.highlight()
      }
    }

    keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || !this.editable()) return false
      const action = resolveContinuousMenuShortcut(event, options.inlineItems(), options.shortcuts(), options.appShortcuts(), options.platform)
      if (!action) return false
      if (action !== 'openInlineMenu' && options.canRunAction?.(action) === false) {
        this.openQuick(false)
        this.fail('该功能尚未接入大文件编辑器')
        return true
      }
      return action === 'openInlineMenu' ? this.openQuick(getContinuousMenuContext(this.view.state).table) : this.action(action)
    }

    startDrag() {
      this.dragging = true
      this.close()
      this.hideAnchors()
      return false
    }

    composition(start: boolean) {
      this.composing = start
      if (start) { this.close(); this.hideAnchors() }
      else this.measure()
      return false
    }

    private contextDOM = (event: MouseEvent) => {
      if (!event.defaultPrevented && this.contextmenu(event)) event.preventDefault()
    }

    contextmenu(event: MouseEvent) {
      if (this.forwardingPreviewClose || this.composing || this.view.composing || this.dragging || this.disposed) return false
      const clicked = (event.target as Element | null)?.closest?.('.looma-continuous-image, a[href]')
      const position = clicked && this.view.contentDOM.contains(clicked)
        ? this.view.posAtDOM(clicked, 0) : this.view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
      if (position === null) return false
      // A source-backed link may already have expanded and lost its <a> DOM.
      const target = getContinuousMenuContext(this.view.state, position).target
      const selection = getContinuousContextSelection(this.view.state, position)
      if (this.view.state.selection.main.empty && !options.hasTableSelection?.(this.view.state)) this.view.dispatch({ selection })
      this.view.focus()
      const state = this.view.state
      const editable = this.editable()
      const reference = target?.kind === 'link' && !!target.destination
        && !!parseNoteLinkHref(state.doc.sliceString(target.destination.from, target.destination.to), '')
      const items: MenuItem[] = contextClipboardItems({
        isMac: /mac|darwin/i.test(options.platform), reference,
        sourceCopy: !!target || !!options.hasTableSelection?.(state) || getContinuousMenuContext(state).copySource, readOnly: !editable,
      }).map(item => ({ ...item, activate: () => { void this.clipboard(item.id === 'paste' ? 'paste' : item.id === 'copy-source' ? 'copy-source' : 'copy', item.id !== 'paste' ? target ?? undefined : undefined) } }))
      if (editable && getContinuousMenuContext(state).table) items.push(...continuousTableMenuItems().map(item => ({ ...item, activate: () => { this.action(item.id) } })))
      this.show(items, { left: event.clientX, top: event.clientY }, true, getContinuousMenuContext(state).table)
      // NoteLinkPreview's public DOM contract is contextmenu on a note anchor
      // plus [data-looma-editor-context-menu]. Forward a cancellation-only event
      // through an inert anchor when the clicked source has no live anchor.
      this.cancelHoverPreview()
      return true
    }

    private cancelHoverPreview() {
      const anchor = this.doc.createElement('a')
      anchor.href = 'looma-context-menu.md'
      anchor.hidden = true
      this.root.append(anchor)
      this.forwardingPreviewClose = true
      try { anchor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) }
      finally { this.forwardingPreviewClose = false; anchor.remove() }
    }

    private async clipboard(action: 'copy' | 'copy-source' | 'paste', range?: { from: number; to: number }) {
      const state = this.view.state
      if (action === 'paste' && !this.editable()) return
      try {
        if (options.clipboard) {
          const completed = await options.clipboard(action, range)
          if (this.disposed || !completed) return
          this.close(); this.view.focus(); this.measure()
          return
        }
        const clipboard = this.win.navigator.clipboard
        if (!clipboard) throw new Error('clipboard unavailable')
        if (action === 'paste') {
          const text = await clipboard.readText()
          if (this.disposed || this.view.state !== state || !this.editable()) return
          this.view.dispatch(state.replaceSelection(text), { userEvent: 'input.paste' })
        } else {
          // Source extraction only happens inside this explicit user action.
          const text = range ? state.doc.sliceString(range.from, range.to)
            : state.selection.ranges.map(selection => state.doc.sliceString(selection.from, selection.to)).join('\n')
          await clipboard.writeText(text)
          if (this.disposed) return

        }
        this.close()
        this.view.focus()
        this.measure()
      } catch {
        this.fail(action === 'paste' ? '无法读取剪贴板，请使用系统粘贴快捷键' : '无法写入剪贴板，请使用系统复制快捷键')
      }
    }

    destroy() {
      this.disposed = true
      this.close()
      this.restoreNumber()
      this.observer?.disconnect()
      this.view.dom.removeEventListener('contextmenu', this.contextDOM, true)
      this.doc.removeEventListener('pointerdown', this.outside, true)
      this.doc.removeEventListener('pointerup', this.release, true)
      this.doc.removeEventListener('pointercancel', this.release, true)
      this.doc.removeEventListener('dragend', this.release, true)
      this.doc.removeEventListener('drop', this.release, true)
      this.doc.removeEventListener('keydown', this.panelKey, true)
      this.win.removeEventListener('scroll', this.scrolled, true)
      this.win.removeEventListener('resize', this.geometryChanged)
      this.win.removeEventListener('blur', this.blurred)
      this.win.visualViewport?.removeEventListener('resize', this.geometryChanged)
      this.win.visualViewport?.removeEventListener('scroll', this.geometryChanged)
      queueMicrotask(() => {
        render(null, this.panel)
        render(null, this.plusHost)
        render(null, this.tableHost)
      })
      this.root.remove()
    }
  }, { eventHandlers: {
    keydown(event) { return this.keydown(event) },
    contextmenu(event) { return event.defaultPrevented || this.contextmenu(event) },
    compositionstart() { return this.composition(true) },
    compositionend() { return this.composition(false) },
    dragstart() { return this.startDrag() },
    mousedown(event) { return event.button === 2 && !this.view.state.selection.main.empty },
  } })
  return plugin
}
