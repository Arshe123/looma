<script setup lang="ts">
import { inject, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from 'vue'
import { Compartment, EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { getContinuousBlockLine } from './continuousMarkdownBlocks'
import { continuousMarkdownCode } from './continuousMarkdownCode'
import { continuousMarkdownSyntax } from './continuousMarkdownSyntax'
import { runContinuousMarkdownCommand, adjustContinuousHeading } from './continuousMarkdownCommands'
import { runContinuousTableCommand, insertContinuousTable, handleContinuousTableDelete, handleContinuousTableArrow } from './continuousMarkdownTable'
import { continuousTableSelection, getContinuousTableSelection, continuousTableSelectedText, continuousTableCutPayload, pasteContinuousTableClipboard } from './continuousMarkdownTableSelection'
import { continuousMarkdownMenus, refreshContinuousMarkdownMenus } from './continuousMarkdownMenus'
import { createContinuousMarkdownClipboard } from './continuousMarkdownClipboard'
import EditorDropAlert from './EditorDropAlert.vue'
import ContinuousNoteRefPicker from './ContinuousNoteRefPicker.vue'
import ContinuousMediaControls from './ContinuousMediaControls.vue'
import { createContinuousMarkdownReferences, getContinuousReferenceAtPosition, type ContinuousReferenceRequest } from './continuousMarkdownReferences'
import { createContinuousMediaController, continuousMarkdownMedia } from './continuousMarkdownMedia'
import { externalDocumentKey } from './documentSession'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import './continuousMarkdownReferences.css'
import type { MarkdownReferenceIndex } from '@/shared/utils/markdown-reference-index'
import type { ChunkedDocument } from '@/shared/utils/chunked-document'
import type { NoteTitleMetadata } from '@/shared/utils/markdown-renderer'
import { resolveMarkdownImagePath } from '@/shared/utils/markdown-image-path'
import { dispatchOpenNoteRef, parseNoteLinkHref } from '@/shared/utils/note-link-ref'
import { dispatchEditorFocus } from '@/shared/utils/editor-focus'
import { isPrimaryModifierPressed } from '@/shared/utils/platform-shortcuts'
import { getTextFormatShortcutAction, matchesEditorShortcut, type TextFormatShortcutId } from '@/shared/utils/editor-shortcuts'
import { getWritingBottomMargin } from '@/shared/utils/editor-writing-scroll'
import { useSettingsStore } from '@/renderer/stores/settings'
import { continuousMarkdown, getContinuousMarkdownLinkAt, refreshContinuousMarkdown } from './continuousMarkdown'
import type { ScrollSyncState } from '@/shared/types/ScrollSyncState'
import type { MarkdownOutlineItem } from '@/shared/types/MarkdownOutlineItem'
import '@/renderer/styles/note-title.css'
import '@/renderer/styles/rich-text-presentation.css'

const props = withDefaults(defineProps<{
  content: string
  documentModel: ChunkedDocument
  documentRevision: number
  filePath: string
  relativeFilePath: string
  isPartial: boolean
  isLoadingMore: boolean
  isLoadingFullContent?: boolean
  totalBytes: number
  sourceOnly?: boolean
  showLineNumbers?: boolean
  scrollSyncEnabled?: boolean
}>(), { sourceOnly: false, showLineNumbers: true, scrollSyncEnabled: false, isLoadingFullContent: false })
const emit = defineEmits<{
  (event: 'update:content', content: string): void
  (event: 'save', content: string): void
  (event: 'edit-pending'): void
  (event: 'document-change'): void
  (event: 'request-edit', offset: number): void
  (event: 'load-more'): void
  (event: 'scroll-sync', state: ScrollSyncState): void
}>()
const container = ref<HTMLElement | null>(null)
const settings = useSettingsStore()
const workspace = useWorkspaceStore()
const external = inject(externalDocumentKey, false)
const presentation = new Compartment()
const editability = new Compartment()
const imageCache = new Map<string, Promise<string | null>>()
let view: EditorView | null = null
let localRevision = -1
let enabled = true
let pendingContent = false
let emitTimer: ReturnType<typeof setTimeout> | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined
let metadataTimer: ReturnType<typeof setTimeout> | undefined
let metadataWorker: Worker | null = null
let metadata: NoteTitleMetadata | null = null
let references: MarkdownReferenceIndex = new Map()
let referenceRevision = -1
const emptyReferences: MarkdownReferenceIndex = new Map()
const currentReferences = () => referenceRevision === doc().revision ? references : emptyReferences
let metadataRequest = 0
let scrollFrame = 0
let navigationGeneration = 0
let deferredSync = false
const doc = () => props.documentModel
const clipboardError = ref({ message: '', detail: '' })
const workspaceId = () => external ? null : workspace.activeWorkspaceId
const referenceRequest = shallowRef<ContinuousReferenceRequest | null>(null)
const noteReferences = createContinuousMarkdownReferences({
  enabled: () => enabled && !props.sourceOnly && !props.isPartial,
  identity: () => ({ workspaceId: workspaceId(), fromRelativePath: props.relativeFilePath, revision: doc().revision }),
  onPickerChange: request => { referenceRequest.value = request },
})
const mediaControls = ref<InstanceType<typeof ContinuousMediaControls> | null>(null)
const media = createContinuousMediaController({
  view: () => view,
  session: () => ({ identity: doc(), revision: doc().revision, filePath: props.filePath, relativeFilePath: props.relativeFilePath,
    workspaceId: workspaceId(), editable: enabled && !props.isPartial && !view?.state.readOnly && !view?.composing, sourceOnly: props.sourceOnly }),
  api: window.electronAPI,
  setBusy: (busy, message) => workspace.setBusy(busy, message),
  reportError: (message, detail = '') => { if (enabled) clipboardError.value = { message, detail } },
})
const clipboard = createContinuousMarkdownClipboard({
  getView: () => view,
  readSource: (from, to) => doc().text.sliceString(from, to),
  writeText: text => navigator.clipboard.writeText(text),
  getDocument: () => container.value!.ownerDocument,
  isActive: () => enabled,
  isPartial: () => props.isPartial,
  sourceOnly: () => props.sourceOnly,
  getDocumentIdentity: doc,
  getRevision: () => doc().revision,
  getSelectionIdentity: () => view ? getContinuousTableSelection(view.state) : null,
  readClipboard: readClipboardPayload,
  reportError: (message, detail) => { if (enabled) clipboardError.value = { message, detail } },
})

async function readClipboardPayload() {
  const clipboard = navigator.clipboard
  if (!clipboard.read) return { text: await clipboard.readText() }
  const items = await clipboard.read()
  let text = '', html = ''
  for (const item of items) {
    if (item.types.some(type => type.startsWith('image/'))) return { files: true }
    if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text()
    if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text()
  }
  return { text, html }
}
function publish() {
  if (emitTimer) clearTimeout(emitTimer)
  emitTimer = undefined
  if (pendingContent) { pendingContent = false; emit('update:content', doc().content) }
  return doc().content
}
function save() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = undefined
  if (!props.isPartial) emit('save', publish())
}
function changed() {
  pendingContent = true
  emit('edit-pending')
  emit('document-change')
  if (emitTimer) clearTimeout(emitTimer)
  if (saveTimer) clearTimeout(saveTimer)
  emitTimer = setTimeout(publish, 150)
  saveTimer = setTimeout(save, 1000)
}
function publishFocus() {
  if (!enabled || !view || !view.hasFocus) return
  dispatchEditorFocus({ relativePath: props.relativeFilePath, label: '正文', sourceLine: view.state.doc.lineAt(view.state.selection.main.head).number })
}
// Apply source revisions, never replace the editor or serialize its rendered DOM.
// Both panes use the same canonical history; inactive panes consume composed diffs.
function syncFromDocument(forceSelection = false) {
  if (!view) return
  if (view.composing) { deferredSync = true; return }
  deferredSync = false
  if (localRevision === doc().revision) {
    if (forceSelection) view.update([view.state.update({ selection: doc().selection })])
    return
  }
  const changes = doc().changesSince(localRevision)
  view.update([view.state.update({
    changes: changes && changes.length === view.state.doc.length
      ? changes : { from: 0, to: view.state.doc.length, insert: doc().text },
    selection: doc().selection,
  })])
  localRevision = doc().revision
}
function dispatchTransactions(transactions: readonly Transaction[], current: EditorView) {
  for (const transaction of transactions) {
    if (!enabled || (props.isPartial && transaction.docChanged)) continue
    if (!transaction.docChanged) {
      current.update([transaction])
      if (transaction.selection) {
        const selection = transaction.state.selection.main
        doc().select(selection.anchor, selection.head)
        publishFocus()
      }
      continue
    }
    // A delayed external revision can arrive during IME. Rebase the edit on the
    // canonical rope rather than overwriting it with the stale local document.
    const remote = doc().changesSince(localRevision)
    const rebased = remote && !remote.empty ? transaction.changes.map(remote) : transaction.changes
    const selection = remote && !remote.empty
      ? transaction.state.selection.main.map(remote.map(transaction.changes, true))
      : transaction.state.selection.main
    const changes: { from: number; to: number; insert: string }[] = []
    rebased.iterChanges((from, to, _fromB, _toB, inserted) => changes.push({ from, to, insert: inserted.toString() }))
    doc().applyChanges(changes, { anchor: selection.anchor, head: selection.head }, transaction.annotation(Transaction.userEvent))
    current.update([transaction])
    if (remote && !remote.empty) {
      localRevision = -1
      deferredSync = true
      if (!current.composing) syncFromDocument(true)
    } else localRevision = doc().revision
    changed()
  }
}
function selectSource(anchor: number, head = anchor) {
  syncFromDocument()
  doc().select(anchor, head)
  view?.update([view.state.update({ selection: doc().selection })])
}
function startEditing(offset = doc().selection.head, select = true) {
  if (props.isPartial) { emit('request-edit', offset); return }
  syncFromDocument()
  if (select) selectSource(offset)
  else view?.update([view.state.update({ selection: doc().selection })])
  view?.focus()
  if (view) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest' }) })
  publishFocus()
}
function stopEditing() {
  if (pendingContent) publish()
  view?.contentDOM.blur()
}
function undo(redo = false) {
  if (props.isPartial || !enabled || view?.composing) return false
  if (!(redo ? doc().redo() : doc().undo())) return true
  syncFromDocument(true)
  changed()
  if (view) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest' }) })
  return true
}
async function resolveImage(source: string) {
  if (/^https?:\/\//i.test(source) || /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);/i.test(source)) return source
  const path = resolveMarkdownImagePath(source, props.filePath)
  if (!path) return null
  let pending = imageCache.get(path)
  if (!pending) {
    pending = window.electronAPI.file.readFileBase64(path).then(result => result.success && result.data ? result.data : null).catch(() => null)
    imageCache.set(path, pending)
    void pending.then(data => { if (!data && imageCache.get(path) === pending) imageCache.delete(path) })
  }
  return pending
}
function presentationExtension() {
  // Rich text uses native text selection, like Tiptap. CM's drawn selection
  // fills source-line tails and paints behind opaque cells/code shells.
  return props.sourceOnly ? [drawSelection(), highlightActiveLine()] : [continuousMarkdown({
    contextAt: offset => doc().contextAt(offset), resolveImage, metadata: () => metadata, references: currentReferences,
  }), continuousMarkdownCode(), noteReferences.extension, continuousMarkdownMedia(media), continuousTableSelection({
    enabled: () => enabled && !props.sourceOnly,
    reportError: (message, detail) => { if (enabled) clipboardError.value = { message, detail } },
  }), continuousMarkdownMenus({
    inlineItems: () => settings.inlineMenuItems, shortcuts: () => settings.editorShortcuts,
    appShortcuts: () => settings.appShortcuts, platform: window.electronAPI.platform,
    hasTableSelection: state => !!getContinuousTableSelection(state),
    clipboard: async (action, range) => {
      if (action === 'paste') return clipboard.paste(async () => {
        if (workspaceId() && await media.pasteFromMenu()) return { files: true }
        return readClipboardPayload()
      }, payload => view && getContinuousTableSelection(view.state)
        ? pasteContinuousTableClipboard(view, payload, view.dom.ownerDocument) : clipboard.pastePayload(payload))
      const reference = range && view ? getContinuousReferenceAtPosition(view.state, range.from + 1, currentReferences()) : null
      if (!range && view && getContinuousTableSelection(view.state)) {
        if (action === 'copy') return clipboard.copy(continuousTableSelectedText(view.state) ?? '')
        const payload = continuousTableCutPayload(view.state, view.dom.ownerDocument)
        return payload ? clipboard.copySource(payload.source) : false
      }
      return range ? clipboard.copySource(reference?.source ?? doc().text.sliceString(range.from, range.to))
        : action === 'copy-source' ? clipboard.copySource() : clipboard.copy()
    },
    runAction: (current, action) => enabled && !props.isPartial && (action === 'image' ? mediaControls.value?.openDialog() === true
      : runContinuousMarkdownCommand(current, action) || runContinuousTableCommand(current, action)),
    insertTable: (current, rows, columns) => enabled && !props.isPartial && insertContinuousTable(current, rows, columns),
  })]
}
function formatSelection(action: TextFormatShortcutId) {
  if (!view || props.isPartial) return
  runContinuousMarkdownCommand(view, action)
}
function moveTableCell(backward: boolean) {
  if (!view || props.isPartial) return false
  const document = view.state.doc, selection = view.state.selection.main
  const line = document.lineAt(selection.head)
  const tree = syntaxTree(view.state)
  const table = getContinuousBlockLine(document, tree, line).table
  if (!table || table.separator) return false
  const index = table.cells.findIndex(cell => cell.from <= selection.from && cell.to >= selection.to)
  if (index < 0) return false
  let target = table.cells[index + (backward ? -1 : 1)]
  if (!target) {
    let number = line.number + (backward ? -1 : 1)
    while (number > 0 && number <= document.lines) {
      const next = getContinuousBlockLine(document, tree, document.line(number)).table
      if (!next || next.from !== table.from) break
      if (!next.separator) { target = next.cells[backward ? next.cells.length - 1 : 0]; break }
      number += backward ? -1 : 1
    }
  }
  if (target) {
    const whitespace = /^[\t ]*/.exec(document.sliceString(target.from, Math.min(target.to, target.from + 256)))![0].length
    const position = target.from + whitespace
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(position, position === target.to ? -1 : 1)]), effects: EditorView.scrollIntoView(target.from, { y: 'nearest' }) })
  } else if (!backward) {
    const prefix = /^(?:[\t ]*>[\t ]?)*[\t ]*/.exec(document.sliceString(line.from, Math.min(line.to, line.from + 256)))![0]
    const row = '\n' + prefix + '| ' + Array(table.columns).fill(' ').join(' | ') + ' |'
    view.dispatch({ changes: { from: line.to, insert: row }, selection: { anchor: line.to + 1 + prefix.length + 2 } })
  } else view.dispatch({ selection: { anchor: table.from } })
  return true
}
function handleKeyDown(event: KeyboardEvent) {
  if (!enabled || props.sourceOnly || view?.composing) return false
  if (view && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
    && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && handleContinuousTableArrow(view, event.key === 'ArrowLeft')) {
    event.preventDefault(); return true
  }
  if (view && (event.key === 'Backspace' || event.key === 'Delete') && handleContinuousTableDelete(view, event.key === 'Backspace')) {
    event.preventDefault(); return true
  }
  if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey && moveTableCell(event.shiftKey)) { event.preventDefault(); return true }
  for (const [id, direction] of [['headingLevelUp', 'up'], ['headingLevelDown', 'down']] as const) {
    if (view && matchesEditorShortcut(event, settings.editorShortcuts[id], window.electronAPI.platform)) {
      event.preventDefault(); adjustContinuousHeading(view, direction); return true
    }
  }
  const action = getTextFormatShortcutAction(event, settings.editorShortcuts, window.electronAPI.platform)
  if (!action) return false
  event.preventDefault()
  if (action !== 'blocked') formatSelection(action)
  return true
}
function linkHrefAtEvent(event: MouseEvent) {
  if (!(event.target instanceof Element) || !view) return ''
  const link = event.target.closest<HTMLElement>('[data-href],a[href]')
  if (link) return link.dataset.href || link.getAttribute('href') || ''
  if (props.sourceOnly || !isPrimaryModifierPressed(event, window.electronAPI.platform)) return ''
  const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
  if (position === null || getContinuousBlockLine(view.state.doc, syntaxTree(view.state), view.state.doc.lineAt(position)).literal) return ''
  return getContinuousMarkdownLinkAt(view.state.doc, position, syntaxTree(view.state), currentReferences())?.href || ''
}
function preserveLinkClickSelection(event: MouseEvent) {
  if (event.button !== 0 || !isPrimaryModifierPressed(event, window.electronAPI.platform) || !linkHrefAtEvent(event)) return false
  event.preventDefault()
  return true
}
function handleClick(event: MouseEvent) {
  if (!(event.target instanceof Element) || !view) return false
  const link = event.target.closest<HTMLElement>('[data-href],a[href]')
  if (link) event.preventDefault()
  const href = linkHrefAtEvent(event)
  if (href && isPrimaryModifierPressed(event, window.electronAPI.platform)) {
    event.preventDefault()
    const target = parseNoteLinkHref(href, props.relativeFilePath)
    if (target) dispatchOpenNoteRef(target)
    else if (/^https?:/i.test(href)) void window.electronAPI.app.openExternal(href)
    return true
  }
  publishFocus()
  return false
}
function requestPartialEdit(event: MouseEvent | InputEvent) {
  if (!props.isPartial || !view || !enabled) return false
  event.preventDefault()
  const offset = event instanceof MouseEvent ? view.posAtCoords({ x: event.clientX, y: event.clientY }) : view.state.selection.main.head
  emit('request-edit', offset ?? doc().selection.head)
  return true
}
function getScrollState(): ScrollSyncState {
  if (!view) return { ratio: 0 }
  const root = view.scrollDOM, rect = root.getBoundingClientRect()
  const height = rect.top + 4 - view.documentTop
  const block = view.lineBlockAtHeight(height)
  const line = view.state.doc.lineAt(block.from)
  const progress = Math.max(0, Math.min(0.999999, (height - block.top) / Math.max(1, block.height)))
  return {
    ratio: root.scrollTop / Math.max(1, root.scrollHeight - root.clientHeight),
    sourceOffset: view.posAtCoords({ x: rect.left + 64, y: rect.top + 4 }) ?? line.from,
    sourceLine: line.number + progress,
  }
}
function applyScrollState(state: ScrollSyncState) {
  if (!view) return
  const root = view.scrollDOM
  if (state.sourceLine !== undefined) {
    const number = Math.max(1, Math.min(doc().text.lines, Math.floor(state.sourceLine)))
    const block = view.lineBlockAt(doc().offsetForLine(number))
    const rect = root.getBoundingClientRect()
    root.scrollTop += view.documentTop + block.top + (state.sourceLine - number) * block.height - rect.top - 4
  } else if (state.sourceOffset !== undefined) {
    view.dispatch({ effects: EditorView.scrollIntoView(Math.max(0, Math.min(doc().length, state.sourceOffset)), { y: 'start', yMargin: 4 }) })
  } else root.scrollTop = state.ratio * Math.max(0, root.scrollHeight - root.clientHeight)
}
function handleScroll() {
  if (scrollFrame || !enabled) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    if (!view || !enabled) return
    const root = view.scrollDOM
    if (props.isPartial && !props.isLoadingMore && root.scrollHeight - root.scrollTop - root.clientHeight < 1200) emit('load-more')
    if (props.scrollSyncEnabled) emit('scroll-sync', getScrollState())
  })
}
async function scrollToLine(line: number) {
  const generation = ++navigationGeneration
  const offset = doc().offsetForLine(line)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!view || !enabled || generation !== navigationGeneration) return
    view.dispatch({ effects: EditorView.scrollIntoView(offset, { y: 'start', yMargin: 4 }) })
    await nextTick()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
}
function queueMetadata() {
  const requestId = ++metadataRequest
  if (metadataTimer) clearTimeout(metadataTimer)
  if (props.sourceOnly || !metadataWorker) return
  metadataTimer = setTimeout(() => { metadataWorker?.postMessage({ requestId, revision: doc().revision, content: doc().content, isPartial: props.isPartial }) }, 300)
}
watch([() => props.content, () => props.isPartial], queueMetadata)
watch(() => props.documentRevision, () => syncFromDocument())
watch(() => props.isPartial, () => {
  view?.dispatch({ effects: editability.reconfigure(EditorState.readOnly.of(props.isPartial)) })
})
watch(() => props.sourceOnly, () => {
  clipboard.invalidate()
  noteReferences.cancel(); media.clearSelection(); mediaControls.value?.closeDialog()
  view?.dispatch({ effects: presentation.reconfigure(presentationExtension()) })
})
watch([() => props.documentModel, () => props.filePath, () => props.relativeFilePath, () => props.isPartial, workspaceId], () => {
  clipboard.invalidate()
  noteReferences.cancel(); media.clearSelection(); mediaControls.value?.closeDialog()
  clipboardError.value = { message: '', detail: '' }
})
watch([() => settings.inlineMenuItems, () => settings.editorShortcuts, () => settings.appShortcuts],
  () => view?.dispatch({ effects: refreshContinuousMarkdownMenus.of(null) }), { deep: true })
watch([() => settings.richTextZoom, () => settings.fontPreset, () => props.showLineNumbers], () => {
  view?.dispatch({ effects: refreshContinuousMarkdownMenus.of(null) })
  view?.requestMeasure()
})
onMounted(() => {
  if (!container.value) return
  view = new EditorView({ parent: container.value, dispatchTransactions, state: EditorState.create({
    doc: doc().text, selection: doc().selection,
    extensions: [
      EditorState.lineSeparator.of('\n'), EditorView.lineWrapping, highlightActiveLineGutter(), lineNumbers({ formatNumber: (number, state) => {
        // The gutter also formats a synthetic widest-number spacer (e.g. 999).
        if (!props.sourceOnly && number > 0 && number <= state.doc.lines) {
          const block = getContinuousBlockLine(state.doc, syntaxTree(state), state.doc.line(number))
          if (block.setextMarker || block.table || (block.literal && !block.html)) return ''
        }
        return String(number)
      } }),
      markdown({ base: markdownLanguage, extensions: continuousMarkdownSyntax, addKeymap: false, pasteURLAsLink: false, completeHTMLTags: false }),
      editability.of(EditorState.readOnly.of(props.isPartial)), presentation.of(presentationExtension()),
      // User-configured text formatting wins over CodeMirror defaults (Mod-i).
      Prec.highest(EditorView.domEventHandlers({ keydown: handleKeyDown })),
      keymap.of([{ key: 'Mod-z', run: () => undo() }, { key: 'Mod-Shift-z', run: () => undo(true) }, { key: 'Mod-y', run: () => undo(true) }, ...markdownKeymap, indentWithTab, ...defaultKeymap]),
      EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': '连续笔记编辑区' }),
      EditorView.scrollMargins.of(current => ({ bottom: getWritingBottomMargin(current.scrollDOM, current.contentDOM) })),
      EditorView.theme({
        '&': { height: '100%', fontSize: 'var(--rich-text-font-size, 1rem)', color: 'var(--text-main)', backgroundColor: 'transparent' },
        '&.cm-focused': { outline: 'none' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-body)', lineHeight: '1.75' },
        '.cm-content': { padding: '2rem 2rem calc(2rem + 22vh) 3rem', width: '100%', maxWidth: '880px', margin: '0 auto', boxSizing: 'border-box', caretColor: 'var(--text-main)' },
        '.cm-line': { padding: '0', minHeight: '1.75em' },
        '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--text-subtle)', border: 'none', fontFamily: 'var(--font-code)' },
        '.cm-activeLine': { backgroundColor: 'var(--editor-active-line-bg)' },
        '.cm-selectionBackground': { backgroundColor: 'var(--accent-soft)' },
      }),
      EditorView.domEventHandlers({
        copy: event => clipboard.handleCopy(event),
        cut: event => clipboard.handleCut(event),
        paste: event => clipboard.handlePaste(event),
        click: handleClick,
        mousedown: event => preserveLinkClickSelection(event) || requestPartialEdit(event), beforeinput: requestPartialEdit,
        focus: () => { publishFocus(); return false },
        blur: () => { if (pendingContent) save(); return false },
        scroll: () => { handleScroll(); return false },
        compositionend: () => { requestAnimationFrame(() => { if (deferredSync) syncFromDocument(true) }); return false },
      }),
    ],
  }) })
  localRevision = doc().revision
  view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true })
  if (!props.sourceOnly) {
    metadataWorker = new Worker(new URL('../../workers/chunked-note-metadata.worker.ts', import.meta.url), { type: 'module' })
    metadataWorker.onmessage = (event: MessageEvent<{ requestId: number; revision: number; metadata: NoteTitleMetadata | null; references: MarkdownReferenceIndex }>) => {
      if (event.data.requestId !== metadataRequest || event.data.revision !== doc().revision) return
      metadata = event.data.metadata
      references = event.data.references
      referenceRevision = event.data.revision
      view?.dispatch({ effects: refreshContinuousMarkdown.of(null) })
    }
    queueMetadata()
  }
})
onActivated(() => { enabled = true; syncFromDocument(); view?.requestMeasure() })
onDeactivated(() => { enabled = false; navigationGeneration++; clipboard.invalidate(); noteReferences.cancel(); media.clearSelection(); mediaControls.value?.closeDialog(); clipboardError.value = { message: '', detail: '' }; if (pendingContent) publish() })
onBeforeUnmount(() => {
  if (pendingContent) publish()
  enabled = false; navigationGeneration++
  clipboard.destroy()
  noteReferences.cancel(); media.destroy()
  if (emitTimer) clearTimeout(emitTimer)
  if (saveTimer) clearTimeout(saveTimer)
  if (metadataTimer) clearTimeout(metadataTimer)
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
  metadataWorker?.terminate()
  view?.scrollDOM.removeEventListener('scroll', handleScroll)
  view?.destroy(); view = null
})
defineExpose({
  startEditing, stopEditing, selectSource,
  flushPendingMarkdownEmit: publish, getScrollState, applyScrollState,
  focus: () => view?.focus(),
  getSnapshot: () => ({ ...doc().selection, scrollTop: view?.scrollDOM.scrollTop || 0 }),
  applySnapshot: (snapshot: { anchor: number; head: number; scrollTop: number }, options: { focus?: boolean } = {}) => {
    selectSource(snapshot.anchor, snapshot.head)
    if (view) view.scrollDOM.scrollTop = snapshot.scrollTop
    if (options.focus) view?.focus()
  },
  scrollToLine,
  scrollToHeading: (heading: MarkdownOutlineItem) => scrollToLine(heading.line),
})
</script>

<template>
  <div class="chunked-markdown-editor relative h-full w-full min-w-0 overflow-hidden bg-surface" :class="{ 'chunked-source-only': sourceOnly, 'chunked-hide-line-numbers': !showLineNumbers }">
    <div ref="container" class="continuous-editor-host h-full w-full" />
    <ContinuousNoteRefPicker :request="referenceRequest" :controller="noteReferences" />
    <ContinuousMediaControls ref="mediaControls" :controller="media" :file-path="filePath" />
    <EditorDropAlert :open="Boolean(clipboardError.message)" :message="clipboardError.message" :detail="clipboardError.detail" @close="clipboardError = { message: '', detail: '' }" />
    <div v-if="isPartial" class="continuous-partial-state" role="status">
      <span>{{ isLoadingFullContent ? '正在后台加载剩余内容，完成后即可编辑…' : isLoadingMore ? '正在加载更多内容…' : '当前仅加载部分内容，可继续阅读。' }}</span>
      <button v-if="!isLoadingFullContent" class="text-accent" @click="emit('request-edit', doc().selection.head)">加载全文并编辑</button>
    </div>
  </div>
</template>

<style scoped>
:global([data-theme="dark"]) .chunked-markdown-editor { --code-keyword: #c678dd; --code-string: #98c379; --code-number: #d19a66; --code-title: #61afef; }
.chunked-hide-line-numbers :deep(.cm-lineNumbers .cm-gutterElement) { visibility: hidden; }
.chunked-hide-line-numbers :deep(.looma-line-number) { visibility: hidden; }
.chunked-source-only :deep(.cm-scroller) { font-family: var(--font-code) !important; }
.chunked-source-only :deep(.cm-content) { max-width: none; padding: 1rem 1.5rem calc(1rem + 22vh); }
.continuous-partial-state { position: absolute; bottom: 0; left: 0; right: 0; display: flex; gap: 1rem; justify-content: center; padding: .75rem; font-size: .85rem; color: var(--text-muted); background: var(--panel); }
:deep(.looma-continuous-bold) { font-weight: 700; font-synthesis: weight style; }
:deep(.looma-continuous-italic) { font-style: oblique 16deg; font-synthesis: style; }
:deep(.looma-continuous-strike) { text-decoration: line-through; }
:deep(.looma-continuous-highlight) { background: var(--editor-highlight-bg, #f4dc83); color: var(--editor-highlight-text, inherit); }
:deep(.looma-continuous-code), :deep(.looma-continuous-inlineCode) { font-family: var(--font-code); background: var(--panel-soft); border-radius: 3px; }
:deep(.looma-continuous-expanded-source) { background-color: var(--editor-active-line-bg); box-decoration-break: clone; -webkit-box-decoration-break: clone; }
:deep(.looma-continuous-link) { color: var(--accent); text-decoration: underline; cursor: text; }
:deep(.looma-continuous-heading) { font-weight: 700; }
:deep(.looma-continuous-h1) { font-size: 1.9em; line-height: 1.5; }
:deep(.looma-continuous-h2) { font-size: 1.5em; line-height: 1.5; }
:deep(.looma-continuous-h3) { font-size: 1.25em; }
:deep(.looma-continuous-h4), :deep(.looma-continuous-h5), :deep(.looma-continuous-h6) { font-size: 1.1em; }
:deep(.looma-continuous-quote) { padding-left: 1rem !important; color: var(--text-muted); background-image: repeating-linear-gradient(to right, var(--border-soft) 0 3px, transparent 3px 1rem); background-size: calc(var(--quote-depth, 1) * 1rem) 100%; background-repeat: no-repeat; }
:deep(.looma-continuous-list) { padding-left: 1.25rem !important; }
:deep(.looma-continuous-bullet) { color: var(--text-muted); margin-left: -1rem; margin-right: .5rem; user-select: none; }

:deep(.looma-continuous-html-source) { font-family: var(--font-code); color: var(--text-muted); }
:deep(.looma-continuous-structural-line) { height: 1px; min-height: 1px !important; line-height: 1px !important; font-size: 0; }
:deep(.looma-continuous-task) { margin: 0 .5em 0 0; accent-color: var(--accent); vertical-align: middle; cursor: pointer; }
:deep(.looma-continuous-rule) { display: inline-block; width: 100%; height: 1px; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }

:deep(.looma-continuous-image) { display: inline-block; max-width: 100%; vertical-align: middle; }
:deep(.looma-continuous-image img) { display: block; max-width: 100%; height: auto; }
:deep(.looma-note-reading-time) { font-family: var(--font-ui); font-size: .75rem; font-weight: 400; color: var(--text-muted); margin-left: 1rem; }
</style>
