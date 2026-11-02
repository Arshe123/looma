import { EditorSelection, type EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { Editor } from '@tiptap/vue-3'
import { resolveMarkdownImagePath } from '@/shared/utils/markdown-image-path'
import { captureTiptapFileTransfer, partitionClipboardImagePaths, transferContainsClipboardImage } from '@/shared/utils/tiptap-clipboard'
import { importImageBatch } from '@/shared/utils/image-import-batch'
import { computeResizedImageWidthPercent, formatMarkdownImage, parseMarkdownImageBlock, type ImportedImage, type MarkdownImageTarget } from '@/shared/utils/tiptap-image-insertion'

export type ContinuousImageContext = MarkdownImageTarget & { from: number; to: number; source: string }

/** Only inspect the syntax node at the pointer, never scan the complete document. */
export function getContinuousImageContext(state: EditorState, position: number): ContinuousImageContext | null {
  for (const bias of [-1, 1] as const) {
    let node = syntaxTree(state).resolveInner(position, bias)
    while (node.parent && node.name !== 'Image') node = node.parent
    if (node.name !== 'Image' || node.to - node.from > 32768) continue
    const suffix = /^\{width=\d{1,3}%\}/.exec(state.doc.sliceString(node.to, Math.min(state.doc.length, node.to + 13)))?.[0] || ''
    const to = node.to + suffix.length
    const source = state.doc.sliceString(node.from, to)
    const image = parseMarkdownImageBlock(source)
    if (image) return { ...image, from: node.from, to, source }
  }
  return null
}

/** Change only the trailing extension; preserve raw destination, escaping and title. */
export function resizeContinuousImageSource(image: ContinuousImageContext, width: number) {
  return image.source.replace(/\{width=\d{1,3}%\}$/, '') + `{width=${Math.max(10, Math.min(100, Math.round(width)))}%}`
}

export type ContinuousMediaSession = {
  /** Stable per opened-document generation, not merely the pathname. */
  identity: object
  revision: number
  filePath: string
  relativeFilePath: string
  workspaceId: string | null
  editable: boolean
  sourceOnly: boolean
}
export type ContinuousMediaHost = {
  view: () => EditorView | null
  session: () => ContinuousMediaSession
  api: Pick<Window['electronAPI'], 'fs' | 'file'>
  reportError: (message: string, detail?: string) => void
  setBusy: (busy: boolean, message?: string) => void
  writeText?: (text: string) => Promise<void>
}
type Ticket = ContinuousMediaSession & { view: EditorView; doc: EditorState['doc']; from: number; to: number }

/** All writes go through host EditorView.dispatch, hence its canonical rope/history. */
export function createContinuousMediaController(host: ContinuousMediaHost) {
  let destroyed = false, selected: ContinuousImageContext | null = null
  let dialogGeneration = 0
  let selectionTicket: Ticket | null = null
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const session = () => host.session()
  const capture = (from?: number, to?: number): Ticket | null => {
    const view = host.view(), current = session()
    if (destroyed || !view || !current.editable || current.sourceOnly || view.state.readOnly) return null
    return { ...current, view, doc: view.state.doc,
      from: from ?? view.state.selection.main.from, to: to ?? from ?? view.state.selection.main.to }
  }
  const valid = (ticket: Ticket | null): ticket is Ticket => {
    const current = session(), view = host.view()
    return !!ticket && !destroyed && current.editable && !current.sourceOnly && view === ticket.view
      && !view.state.readOnly && current.identity === ticket.identity && current.revision === ticket.revision
      && current.filePath === ticket.filePath && current.relativeFilePath === ticket.relativeFilePath
      && current.workspaceId === ticket.workspaceId && view.state.doc === ticket.doc
  }
  const stale = () => host.reportError('笔记已变化，已取消图片插入。已导入的图片仍保留在 assets 中。')
  const insert = (ticket: Ticket | null, text: string, cursor?: number) => {
    if (!valid(ticket)) { stale(); return false }
    ticket.view.dispatch({ changes: { from: ticket.from, to: ticket.to, insert: text },
      selection: EditorSelection.cursor(ticket.from + (cursor ?? text.length)), userEvent: 'input.media' })
    ticket.view.focus()
    return true
  }
  const importedSource = (image: ImportedImage) => {
    // The import IPC returns an actual note-relative filename, not a URL.
    if (!image.relativePath || /^(?:[a-z][\w+.-]*:|[\\/])/i.test(image.relativePath)) throw new Error('图片导入返回的不是相对路径')
    return formatMarkdownImage({ alt: image.fileName.replace(/([\\[\]])/g, '\\$1'),
      src: image.relativePath.split('/').map(part => encodeURIComponent(part).replace(/[()']/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/') })
  }
  const insertImages = (ticket: Ticket, images: readonly ImportedImage[]) => {
    if (!valid(ticket)) { stale(); return }
    const prefix = ticket.from > 0 && ticket.doc.sliceString(Math.max(0, ticket.from - 2), ticket.from) !== '\n\n' ? '\n\n' : ''
    insert(ticket, prefix + images.map(importedSource).join('\n\n') + '\n\n')
  }
  async function importPaths(paths: readonly string[], at?: number, ticket = capture(at)) {
    if (!ticket) return
    if (!ticket.workspaceId) { host.reportError('当前笔记不在工作空间中，请使用图片插入对话框选择文件。'); return }
    const { supported, unsupported } = partitionClipboardImagePaths(paths)
    if (unsupported.length) { host.reportError('这里只能粘贴或拖入 PNG、JPG、GIF、WebP 或 SVG 图片文件。', unsupported.join('\n')); return }
    if (!supported.length) return
    await importImageBatch({ sourcePaths: supported,
      importImage: path => valid(ticket) ? host.api.fs.importImage(ticket.workspaceId!, ticket.relativeFilePath, path)
        : Promise.resolve({ success: false, error: '笔记已切换，已取消导入。' }),
      setBusy: host.setBusy, reportError: host.reportError,
      insertImages: images => insertImages(ticket, images) })
  }
  async function importClipboard(ticket = capture()) {
    if (!ticket || !ticket.workspaceId) { host.reportError('当前笔记暂不支持剪贴板图片导入，请使用图片插入对话框。'); return false }
    host.setBusy(true, '正在导入图片...')
    try {
      const result = await host.api.fs.importClipboardImage(ticket.workspaceId, ticket.relativeFilePath)
      if (!valid(ticket)) { stale(); return true }
      if (!result.success || !result.data) {
        if (result.error?.includes('剪贴板中没有图片')) return false
        host.reportError('剪贴板图片导入失败，请重新截图后粘贴。', result.error)
        return true
      }
      insertImages(ticket, [result.data]); return true
    } catch (error) { host.reportError('剪贴板图片导入失败，请重新截图后粘贴。', String(error)); return true }
    finally { host.setBusy(false) }
  }
  const api = {
    importPaths,
    importClipboard,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    context() { return valid(selectionTicket) ? selected : null },
    clearSelection() { selected = null; selectionTicket = null; notify() },
    selectImage(image: ContinuousImageContext) {
      const ticket = capture(image.from, image.to)
      if (!ticket || ticket.doc.sliceString(image.from, image.to) !== image.source) return false
      ticket.view.dispatch({ selection: EditorSelection.range(image.from, image.to) })
      ticket.view.focus()
      selected = image; selectionTicket = capture(image.from, image.to); notify(); return true
    },
    copyImage(event?: ClipboardEvent) {
      const image = api.context()
      if (!image) return false
      if (event?.clipboardData) { event.preventDefault(); event.clipboardData.setData('text/plain', image.source) }
      else void (host.writeText ?? (text => navigator.clipboard.writeText(text)))(image.source).catch(error => host.reportError('复制图片失败，请重试。', String(error)))
      return true
    },
    deleteImage() {
      const image = api.context(), ticket = selectionTicket
      if (!image || !valid(ticket)) return false
      const done = insert(ticket, '')
      api.clearSelection(); return done
    },
    resizeImage(width: number) {
      const image = api.context(), ticket = selectionTicket
      if (!image || !valid(ticket) || !Number.isFinite(width)) return false
      const next = resizeContinuousImageSource(image, width)
      if (next === image.source) return true
      const done = insert(ticket, next)
      api.clearSelection(); return done
    },
    resolveSource(source: string) { return resolveMarkdownImagePath(source, session().filePath) },
    handlePaste(event: ClipboardEvent) {
      if (!capture()) return false
      const paths = captureTiptapFileTransfer(event.clipboardData)
      const imageFile = Array.from(event.clipboardData?.files || []).some(file => /^image\//i.test(file.type))
      if (!partitionClipboardImagePaths(paths || []).supported.length && !transferContainsClipboardImage(event.clipboardData) && !imageFile) return false
      event.preventDefault()
      if (paths?.length) void importPaths(paths)
      else void importClipboard()
      return true
    },
    handleDrop(event: DragEvent) {
      const ticket = capture()
      if (!ticket || !Array.from(event.dataTransfer?.types || []).includes('Files')) return false
      event.preventDefault()
      const paths = captureTiptapFileTransfer(event.dataTransfer)
      if (!paths?.length) { host.reportError('无法读取拖入图片，请从系统文件资源管理器重新拖入。'); return true }
      const at = ticket.view.posAtCoords({ x: event.clientX, y: event.clientY }, false) ?? ticket.from
      void importPaths(paths, at); return true
    },
    /** Explicit context-menu paste ONLY; never bind this to Mod-v. */
    async pasteFromMenu() {
      const ticket = capture()
      if (!ticket) return false
      try {
        const files = await host.api.fs.clipboardReadFiles()
        if (!valid(ticket)) return false
        if (files.success && files.data?.length) { await importPaths(files.data, undefined, ticket); return true }
        return await importClipboard(ticket)
      } catch (error) { host.reportError('无法读取剪贴板图片，请重新复制后再试。', String(error)); return true }
    },
    cancelDialog() { dialogGeneration++ },
    /** Narrow compatibility bridge for unchanged ImageInsertDialog, not a Tiptap editor. */
    createDialogEditor(): Editor | null {
      const ticket = capture()
      if (!ticket) return null
      const generation = ++dialogGeneration
      const dialogValid = () => generation === dialogGeneration && valid(ticket)
      const bridge = {
        get isDestroyed() { return !dialogValid() },
        get state() { return { selection: { from: ticket.from } } },
        chain() {
          let text = '', cursor: number | undefined
          const chain = {
            focus() { return chain },
            insertContent(value: string) { text = value; return chain },
            setTextSelection(position: number) { cursor = position - ticket.from; return chain },
            setImage(image: { src: string; alt: string }) {
              text = '\n\n' + importedSource({ relativePath: image.src, fileName: image.alt }) + '\n\n'; return chain
            },
            run() { return dialogValid() && insert(ticket, text, cursor) },
          }
          return chain
        },
      }
      return bridge as unknown as Editor
    },
    destroy() { destroyed = true; selected = null; selectionTicket = null; notify(); listeners.clear() },
  }
  return api
}
export type ContinuousMediaController = ReturnType<typeof createContinuousMediaController>

/** Native listeners run before CM's widget ignoreEvent, leaving ordinary text alone. */
export function continuousMarkdownMedia(media: ContinuousMediaController) {
  return ViewPlugin.define(view => {
    let frame: HTMLElement | null = null, handle: HTMLButtonElement | null = null
    let resize: { x: number; y: number; width: number; height: number; container: number; style: string | null; preview: number | null } | null = null
    const owner = view.dom.ownerDocument, win = owner.defaultView!
    function stopResize(commit = false) {
      const current = resize
      resize = null
      win.removeEventListener('pointermove', move)
      win.removeEventListener('pointerup', end)
      win.removeEventListener('pointercancel', cancel)
      win.removeEventListener('blur', cancel)
      if (!current) return
      if (frame) {
        if (current.style === null) frame.removeAttribute('style')
        else frame.setAttribute('style', current.style)
      }
      if (commit && current.preview !== null) media.resizeImage(current.preview)
    }
    function move(event: PointerEvent) {
      if (!resize || !frame) return
      event.preventDefault()
      resize.preview = computeResizedImageWidthPercent({ startWidth: resize.width, startHeight: resize.height,
        containerWidth: resize.container, deltaX: event.clientX - resize.x, deltaY: event.clientY - resize.y })
      frame.style.width = `${resize.preview}%`
      view.requestMeasure()
    }
    function end() { stopResize(true) }
    function cancel() { stopResize(false) }
    function start(event: PointerEvent) {
      const image = frame?.querySelector('img'), rect = image?.getBoundingClientRect()
      if (!frame || !rect || rect.width <= 0 || rect.height <= 0 || !media.context()) return
      event.preventDefault(); event.stopPropagation()
      const container = frame.parentElement?.clientWidth || 0
      if (container <= 0) return
      resize = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height,
        container, style: frame.getAttribute('style'), preview: null }
      win.addEventListener('pointermove', move, { passive: false })
      win.addEventListener('pointerup', end)
      win.addEventListener('pointercancel', cancel)
      win.addEventListener('blur', cancel)
    }
    function detach() {
      cancel()
      handle?.remove(); handle = null
      frame?.classList.remove('is-media-selected'); frame = null
    }
    function sync() {
      if (!media.context()) detach()
    }
    const unsubscribe = media.subscribe(sync)
    function pointer(event: MouseEvent) {
      const target = event.target as Element | null
      if (target?.closest('.looma-continuous-media-resize')) return
      const wrapper = target?.closest<HTMLElement>('.looma-continuous-image')
      if (!wrapper || !view.contentDOM.contains(wrapper)) { detach(); media.clearSelection(); return }
      const image = getContinuousImageContext(view.state, view.posAtDOM(wrapper, 0))
      if (!image) return
      detach()
      if (!media.selectImage(image)) return
      // contextmenu is not consumed: host menus can read media.context().
      if (event.type !== 'contextmenu') { event.preventDefault(); event.stopPropagation() }
      frame = wrapper; frame.classList.add('is-media-selected')
      handle = owner.createElement('button')
      handle.type = 'button'; handle.tabIndex = -1; handle.className = 'looma-continuous-media-resize'
      handle.setAttribute('aria-label', '从右下角等比例缩放图片')
      handle.addEventListener('pointerdown', start)
      frame.appendChild(handle)
    }
    function key(event: KeyboardEvent) {
      if (!media.context() || event.isComposing || view.composing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (event.key === 'Escape') { detach(); media.clearSelection(); return }
      if ((event.key === 'Backspace' || event.key === 'Delete') && media.deleteImage()) { event.preventDefault(); event.stopPropagation() }
    }
    function paste(event: ClipboardEvent) { if (media.handlePaste(event)) event.stopPropagation() }
    function copy(event: ClipboardEvent) { if (media.copyImage(event)) event.stopPropagation() }
    function drop(event: DragEvent) { if (media.handleDrop(event)) event.stopPropagation() }
    function over(event: DragEvent) {
      if (!view.state.readOnly && Array.from(event.dataTransfer?.types || []).includes('Files')) {
        event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      }
    }
    view.dom.addEventListener('mousedown', pointer, true)
    view.dom.addEventListener('contextmenu', pointer, true)
    view.dom.addEventListener('keydown', key, true)
    view.dom.addEventListener('paste', paste, true)
    view.dom.addEventListener('copy', copy, true)
    view.dom.addEventListener('drop', drop, true)
    view.dom.addEventListener('dragover', over, true)
    return {
      update(update) {
        const selected = media.context(), range = update.state.selection.main
        if (update.docChanged || (update.selectionSet && selected && (range.from !== selected.from || range.to !== selected.to))) {
          detach(); media.clearSelection()
        }
      },
      destroy() {
        detach(); unsubscribe(); media.clearSelection()
        view.dom.removeEventListener('mousedown', pointer, true)
        view.dom.removeEventListener('contextmenu', pointer, true)
        view.dom.removeEventListener('keydown', key, true)
        view.dom.removeEventListener('paste', paste, true)
        view.dom.removeEventListener('copy', copy, true)
        view.dom.removeEventListener('drop', drop, true)
        view.dom.removeEventListener('dragover', over, true)
      },
    }
  })
}


