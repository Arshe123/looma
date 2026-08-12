<script setup lang="ts">
import { shallowRef, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { findChildren } from '@tiptap/core'
import { Editor, EditorContent, VueNodeViewRenderer } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import { CodeBlock } from '@tiptap/extension-code-block'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import { Highlight } from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import { TableRow } from '@tiptap/extension-table-row'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableCell } from '@tiptap/extension-table-cell'
import type { Node as ProsemirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Markdown } from '@tiptap/markdown'
import { common, createLowlight } from 'lowlight'
import 'github-markdown-css/github-markdown-light.css'
import InlineMenu from './InlineMenu.vue'
import ContextMenu from './ContextMenu.vue'
import TableToolbar from './TableToolbar.vue'
import CodeBlockView from './CodeBlockView.vue'
import LocalImageView from './LocalImageView.vue'
import ImageInsertDialog from './ImageInsertDialog.vue'
import NoteRefPicker from './NoteRefPicker.vue'
import EditorDropAlert from '@/renderer/components/editor/EditorDropAlert.vue'
import type { MarkdownOutlineItem } from '@/shared/types/MarkdownOutlineItem'
import { replaceExternalMarkdownContent } from '@/shared/utils/tiptap-content-sync'
import { destroyTiptapEditorSafely } from '@/shared/utils/tiptap-editor-lifecycle'
import { EnhancedTable } from '@/shared/utils/tiptap-table-utils'
import {
  findBestTextAnchor,
  getOffsetForSourceLine,
  getScrollRatio,
  getSourceLineAtOffset,
  setScrollRatio,
} from '@/shared/utils/editor-scroll-sync'
import type { ScrollSyncState } from '@/shared/types/ScrollSyncState'
import { createMarkdownSerializationGate } from '@/shared/utils/markdown-serialization-gate'
import { isPrimaryModifierPressed } from '@/shared/utils/platform-shortcuts'
import {
  prepareMarkdownForRichText,
  serializeMarkdownAst,
} from '@/shared/utils/markdown-rich-text'
import {
  insertImportedImagesAt,
  renderCurrentMarkdownImage,
} from '@/shared/utils/tiptap-image-insertion'
import { getDroppedFilePaths } from '@/shared/utils/external-file-drop'
import {
  getTiptapSelectionDocument,
  getTiptapClipboardCopyText,
  captureTiptapFileTransfer,
  partitionClipboardImagePaths,
  shouldReadClipboardImage,
  transferContainsClipboardImage,
} from '@/shared/utils/tiptap-clipboard'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import {
  dispatchOpenNoteRef,
  parseNoteLinkHref,
} from '@/shared/utils/note-link-ref'
import { LineNumbers } from '@/shared/utils/tiptap-line-numbers'

const props = defineProps<{
  content: string
  filePath: string
  relativeFilePath: string
}>()

const workspaceStore = useWorkspaceStore()

const emit = defineEmits<{
  (e: 'update:content', value: string): void
  (e: 'scroll-sync', value: ScrollSyncState): void
}>()

let isUpdatingFromExternal = false
let lastEmittedContent = ''
let isUnmounting = false
let pendingMarkdownEmitTimer: number | null = null
let pendingCodeHighlightTimer: number | null = null
let pendingHeadingTarget: MarkdownOutlineItem | null = null
let pendingHeadingClearTimer: number | null = null
let scrollSyncFrame: number | null = null
const markdownSerializationGate = createMarkdownSerializationGate()

const editor = shallowRef<Editor | null>(null)
const imageInsertDialogOpen = shallowRef(false)
const noteRefPickerState = shallowRef<{ open: boolean; selectedText: string }>({ open: false, selectedText: '' })
const previewContainerRef = shallowRef<HTMLElement | null>(null)
const dropErrorMessage = shallowRef('')
const dropTechnicalDetail = shallowRef('')
const lowlight = createLowlight(common)
const PREVIEW_IMAGE_SETTLED_EVENT = 'looma:preview-image-settled'
const HEADING_REANCHOR_WINDOW_MS = 1000
const MARKDOWN_EMIT_DEBOUNCE_MS = 150
const CODE_HIGHLIGHT_IDLE_MS = 300
const deferredLowlightKey = new PluginKey('loomaDeferredLowlight')

type HighlightNode = {
  value?: string
  children?: HighlightNode[]
  properties?: {
    className?: string[]
  }
}

type ParsedHighlightText = {
  text: string
  classes: string[]
}

const parseHighlightNodes = (nodes: HighlightNode[], className: string[] = []): ParsedHighlightText[] =>
  nodes.flatMap((node) => {
    const classes = [...className, ...(node.properties?.className || [])]
    if (node.children) return parseHighlightNodes(node.children, classes)
    return {
      text: node.value || '',
      classes,
    }
  })

const getHighlightNodes = (result: any): HighlightNode[] => result.value || result.children || []

const getCodeBlockDecorations = ({
  doc,
  name,
  defaultLanguage,
}: {
  doc: ProsemirrorNode
  name: string
  defaultLanguage?: string | null
}) => {
  const decorations: Decoration[] = []
  const languages = lowlight.listLanguages()

  findChildren(doc, node => node.type.name === name).forEach((block) => {
    let from = block.pos + 1
    const language = block.node.attrs.language || defaultLanguage
    const highlightedNodes = language && (languages.includes(language) || lowlight.registered?.(language))
      ? getHighlightNodes(lowlight.highlight(language, block.node.textContent))
      : getHighlightNodes(lowlight.highlightAuto(block.node.textContent))

    parseHighlightNodes(highlightedNodes).forEach((node) => {
      const to = from + node.text.length
      if (node.classes.length) {
        decorations.push(Decoration.inline(from, to, { class: node.classes.join(' ') }))
      }
      from = to
    })
  })

  return DecorationSet.create(doc, decorations)
}

const isSelectionInNode = (state: EditorState, name: string) =>
  state.selection.$head.parent.type.name === name

const transactionContainsWholeCodeBlock = (
  transaction: Transaction,
  oldState: EditorState,
  name: string,
) => {
  const oldNodes = findChildren(oldState.doc, node => node.type.name === name)
  return transaction.steps.some((step) => {
    const stepRange = step as unknown as { from?: number; to?: number }
    if (stepRange.from === undefined || stepRange.to === undefined) return false
    return oldNodes.some((node) => node.pos >= stepRange.from! && node.pos + node.node.nodeSize <= stepRange.to!)
  })
}

const shouldRefreshCodeDecorations = (
  transaction: Transaction,
  oldState: EditorState,
  newState: EditorState,
  name: string,
) => {
  if (transaction.getMeta(deferredLowlightKey)?.force) return true
  if (!transaction.docChanged) return false

  const oldNodes = findChildren(oldState.doc, node => node.type.name === name)
  const newNodes = findChildren(newState.doc, node => node.type.name === name)

  return isSelectionInNode(oldState, name)
    || isSelectionInNode(newState, name)
    || newNodes.length !== oldNodes.length
    || transactionContainsWholeCodeBlock(transaction, oldState, name)
}

const createDeferredLowlightPlugin = ({
  name,
  defaultLanguage,
}: {
  name: string
  defaultLanguage?: string | null
}) =>
  new Plugin({
    key: deferredLowlightKey,

    state: {
      init: (_, { doc }) => getCodeBlockDecorations({ doc, name, defaultLanguage }),
      apply: (transaction, decorationSet, oldState, newState) => {
        const forceRefresh = Boolean(transaction.getMeta(deferredLowlightKey)?.force)

        if (forceRefresh) {
          return getCodeBlockDecorations({ doc: transaction.doc, name, defaultLanguage })
        }

        if (shouldRefreshCodeDecorations(transaction, oldState, newState, name)) {
          if (isSelectionInNode(oldState, name) || isSelectionInNode(newState, name)) {
            return decorationSet.map(transaction.mapping, transaction.doc)
          }

          return getCodeBlockDecorations({ doc: transaction.doc, name, defaultLanguage })
        }

        return decorationSet.map(transaction.mapping, transaction.doc)
      },
    },

    props: {
      decorations(state) {
        return deferredLowlightKey.getState(state)
      },
    },
  })

const CodeBlockWithHeader = CodeBlock.extend({
  addNodeView() {
    return VueNodeViewRenderer(CodeBlockView)
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() || []),
      createDeferredLowlightPlugin({
        name: this.name,
        defaultLanguage: this.options.defaultLanguage,
      }),
    ]
  },
})

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const resolvedImageCache = new Map<string, string | null>()

const LocalImage = Image.extend({
  addStorage() {
    return {
      resolveImageSrc,
    }
  },

  addNodeView() {
    return VueNodeViewRenderer(LocalImageView)
  },
})

const importImagePaths = async (sourcePaths: string[], insertAt: number) => {
  dropErrorMessage.value = ''
  dropTechnicalDetail.value = ''
  const currentEditor = editor.value
  const workspaceId = workspaceStore.activeWorkspaceId
  if (!currentEditor || currentEditor.isDestroyed || !workspaceId) return

  const { supported, unsupported } = partitionClipboardImagePaths(sourcePaths)
  if (unsupported.length > 0) {
    dropErrorMessage.value = '这里只能粘贴或拖入 PNG、JPG、GIF、WebP 或 SVG 图片文件。'
    dropTechnicalDetail.value = `Unsupported paths: ${unsupported.join(', ')}`
    return
  }
  if (supported.length === 0) return

  const imported: Array<{ relativePath: string; fileName: string }> = []
  const failures: string[] = []
  workspaceStore.setBusy(true, supported.length > 1 ? `正在导入 ${supported.length} 张图片...` : '正在导入图片...')
  try {
    for (const sourcePath of supported) {
      const result = await window.electronAPI.fs.importImage(workspaceId, props.relativeFilePath, sourcePath)
      if (result.success && result.data) imported.push(result.data)
      else failures.push(result.error || sourcePath)
    }
    if (imported.length > 0 && !currentEditor.isDestroyed) {
      if (!insertImportedImagesAt(currentEditor, imported, insertAt)) {
        failures.push(`图片已复制到 assets，但编辑器拒绝在位置 ${insertAt} 插入。`)
      }
    }
    if (failures.length > 0) {
      dropErrorMessage.value = imported.length > 0
        ? '部分图片未能导入，其余图片已插入。'
        : '图片导入失败，请确认图片仍然存在且当前笔记目录可写。'
      dropTechnicalDetail.value = failures.join('\n')
    }
  } catch (error) {
    dropErrorMessage.value = '图片导入失败，请稍后重试。'
    dropTechnicalDetail.value = error instanceof Error ? error.message : String(error)
  } finally {
    workspaceStore.setBusy(false)
  }
}

const importDroppedImages = async (event: DragEvent) => {
  event.preventDefault()
  const currentEditor = editor.value
  if (!currentEditor || currentEditor.isDestroyed) return
  const sourcePaths = getDroppedFilePaths(event.dataTransfer?.files)
  if (sourcePaths.length === 0) {
    dropErrorMessage.value = '无法读取拖入图片，请从系统文件资源管理器重新拖入。'
    dropTechnicalDetail.value = 'Electron did not expose native paths for the dropped File objects.'
    return
  }
  const insertAt = currentEditor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
    ?? currentEditor.state.selection.from
  await importImagePaths(sourcePaths, insertAt)
}

const importClipboardImageAt = async (insertAt: number) => {
  dropErrorMessage.value = ''
  dropTechnicalDetail.value = ''
  const currentEditor = editor.value
  const workspaceId = workspaceStore.activeWorkspaceId
  if (!currentEditor || currentEditor.isDestroyed || !workspaceId) return false

  workspaceStore.setBusy(true, '正在导入图片...')
  try {
    const result = await window.electronAPI.fs.importClipboardImage(workspaceId, props.relativeFilePath)
    if (!result.success || !result.data) {
      if (result.error?.includes('剪贴板中没有图片')) return false
      dropErrorMessage.value = '剪贴板图片导入失败，请重新截图后粘贴。'
      dropTechnicalDetail.value = result.error || 'Clipboard image import returned no data.'
      return true
    }
    if (currentEditor.isDestroyed) return true
    if (!insertImportedImagesAt(currentEditor, [result.data], insertAt)) {
      dropErrorMessage.value = '图片已保存到 assets，但编辑器未能插入图片。'
      dropTechnicalDetail.value = `Editor rejected clipboard image insertion at position ${insertAt}.`
    }
    return true
  } catch (error) {
    dropErrorMessage.value = '剪贴板图片导入失败，请重新截图后粘贴。'
    dropTechnicalDetail.value = error instanceof Error ? error.message : String(error)
    return true
  } finally {
    workspaceStore.setBusy(false)
  }
}

const copyRichTextSelection = async (overrideText?: string) => {
  const currentEditor = editor.value
  if (!currentEditor || currentEditor.isDestroyed) return
  const text = overrideText ?? getTiptapClipboardCopyText(currentEditor.state)
  if (text === null) return
  await navigator.clipboard.writeText(text)
  currentEditor.commands.focus()
}

const copyRichTextSource = async (overrideText?: string) => {
  const currentEditor = editor.value
  if (!currentEditor || currentEditor.isDestroyed) return
  const selectionDocument = getTiptapSelectionDocument(currentEditor.state)
  const markdown = overrideText ?? (selectionDocument
    ? serializeMarkdownAst({
        getJSON: () => selectionDocument,
        markdown: currentEditor.markdown,
      })
    : null)
  if (markdown === null) return
  await navigator.clipboard.writeText(markdown)
  currentEditor.commands.focus()
}

const pasteRichTextClipboard = async () => {
  const currentEditor = editor.value
  if (!currentEditor || currentEditor.isDestroyed) return
  const insertAt = currentEditor.state.selection.from
  const filesResult = await window.electronAPI.fs.clipboardReadFiles()
  if (filesResult.success && filesResult.data?.length) {
    await importImagePaths(filesResult.data, insertAt)
    return
  }

  if (await importClipboardImageAt(insertAt)) return

  const text = await navigator.clipboard.readText()
  if (!text || currentEditor.isDestroyed) return
  currentEditor.view.focus()
  currentEditor.view.pasteText(text)
}

const handleClipboardCopy = (event: ClipboardEvent) => {
  const currentEditor = editor.value
  if (!currentEditor || currentEditor.isDestroyed) return false
  const text = getTiptapClipboardCopyText(currentEditor.state)
  if (text === null || !event.clipboardData) return false
  event.preventDefault()
  event.clipboardData.setData('text/plain', text)
  return true
}

const handleClipboardPaste = (event: ClipboardEvent) => {
  const sourcePaths = captureTiptapFileTransfer(event.clipboardData)
  const currentEditor = editor.value
  if (!currentEditor || currentEditor.isDestroyed) return false
  if (sourcePaths === null) {
    if (!transferContainsClipboardImage(event.clipboardData)) return false
    event.preventDefault()
    void importClipboardImageAt(currentEditor.state.selection.from)
    return true
  }
  event.preventDefault()
  if (sourcePaths.length === 0) {
    if (shouldReadClipboardImage(event.clipboardData)) {
      void importClipboardImageAt(currentEditor.state.selection.from)
      return true
    }
    dropErrorMessage.value = '无法读取粘贴图片，请从系统文件资源管理器重新复制。'
    dropTechnicalDetail.value = 'Electron did not expose native paths for the pasted File objects.'
    return true
  }
  void importImagePaths(sourcePaths, currentEditor.state.selection.from)
  return true
}

const handleExternalImageDragOver = (event: DragEvent) => {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
}

const clearDropError = () => {
  dropErrorMessage.value = ''
  dropTechnicalDetail.value = ''
}

const isPassThroughImageSrc = (src: string) => /^(https?:|data:|blob:)/i.test(src.trim())

const getPathSep = (path: string) => path.includes('\\') ? '\\' : '/'

const getImageExt = (path: string) => {
  const cleanPath = path.split(/[?#]/, 1)[0]
  const base = cleanPath.split(/[\\/]/).pop() || ''
  const idx = base.lastIndexOf('.')
  return idx === -1 ? '' : base.slice(idx + 1).toLowerCase()
}

const isSupportedImagePath = (path: string) => IMAGE_EXTS.has(getImageExt(path))

const isWindowsAbsolutePath = (path: string) => /^[a-zA-Z]:[\\/]/.test(path)
const isUncPath = (path: string) => /^\\\\[^\\]+\\[^\\]+/.test(path)

const decodeMarkdownImageSrc = (src: string) => {
  const raw = src.trim()
  if (isPassThroughImageSrc(raw)) return raw

  try {
    return decodeURIComponent(raw)
  } catch (error) {
    return raw.replace(/%5[cC]/g, '\\').replace(/%20/g, ' ')
  }
}

const decodeFileUrlPath = (src: string) => {
  try {
    const url = new URL(src)
    let pathname = decodeURIComponent(url.pathname)
    if (url.hostname) {
      return `\\\\${url.hostname}${pathname.split('/').join('\\')}`
    }
    if (/^\/[a-zA-Z]:\//.test(pathname)) pathname = pathname.slice(1)
    return pathname.split('/').join(getPathSep(props.filePath || pathname))
  } catch (error) {
    return ''
  }
}

const normalizeNativePath = (path: string, sep = getPathSep(path)) => {
  const normalizedSepPath = path.split(/[\\/]+/).join(sep)
  const driveMatch = normalizedSepPath.match(/^[a-zA-Z]:[\\/]/)
  const prefix = driveMatch ? normalizedSepPath.slice(0, 3) : normalizedSepPath.startsWith(sep) ? sep : ''
  const rest = prefix ? normalizedSepPath.slice(prefix.length) : normalizedSepPath
  const parts: string[] = []

  for (const part of rest.split(sep)) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(part)
  }

  if (!prefix) return parts.join(sep)
  return prefix.endsWith(sep) ? prefix + parts.join(sep) : [prefix, ...parts].join(sep)
}

const getNativeDir = (path: string) => {
  const sep = getPathSep(path)
  const normalized = normalizeNativePath(path, sep)
  const idx = normalized.lastIndexOf(sep)
  if (idx === -1) return ''
  if (idx === 2 && /^[a-zA-Z]:$/.test(normalized.slice(0, 2))) return normalized.slice(0, idx + 1)
  return normalized.slice(0, idx)
}

const joinNativePath = (base: string, relativePath: string) => {
  const sep = getPathSep(base)
  const cleanBase = base.endsWith(sep) ? base.slice(0, -1) : base
  const cleanRelative = relativePath.replace(/^\.?[\\/]+/, '').split(/[\\/]+/).join(sep)
  return normalizeNativePath(`${cleanBase}${sep}${cleanRelative}`, sep)
}

const resolveLocalImagePath = (src: string) => {
  const raw = decodeMarkdownImageSrc(src)
  if (!raw) return ''
  if (/^file:/i.test(raw)) return decodeFileUrlPath(raw)
  if (isWindowsAbsolutePath(raw) || isUncPath(raw)) return normalizeNativePath(raw, getPathSep(raw))

  const currentDir = getNativeDir(props.filePath || '')
  return currentDir ? joinNativePath(currentDir, raw.replace(/^\/+/, '')) : ''
}

async function resolveImageSrc(src: string) {
  const raw = decodeMarkdownImageSrc(src)
  if (isPassThroughImageSrc(raw)) return raw

  const localPath = resolveLocalImagePath(raw)
  if (!localPath || !isSupportedImagePath(localPath)) return null

  const cacheKey = localPath
  if (resolvedImageCache.has(cacheKey)) return resolvedImageCache.get(cacheKey) || null

  const result = await window.electronAPI.file.readFileBase64(localPath)
  if (!result.success || !result.data) return null

  resolvedImageCache.set(cacheKey, result.data)
  return result.data
}

const getScrollableBlocks = () => {
  const container = previewContainerRef.value
  if (!container) return []
  return Array.from(container.querySelectorAll<HTMLElement>(
    '.tiptap h1, .tiptap h2, .tiptap h3, .tiptap h4, .tiptap h5, .tiptap h6, .tiptap p, .tiptap li, .tiptap pre, .tiptap blockquote, .tiptap td, .tiptap th',
  )).filter((element) => (element.textContent || '').trim())
}

const getTopVisibleBlock = () => {
  const container = previewContainerRef.value
  if (!container) return null
  const containerRect = container.getBoundingClientRect()
  return getScrollableBlocks().find((element) => {
    const rect = element.getBoundingClientRect()
    return rect.bottom > containerRect.top + 4
  }) || null
}

const getPreviewSourceLineAnchors = () => {
  const container = previewContainerRef.value
  if (!container) return []
  const containerRect = container.getBoundingClientRect()
  return Array.from(container.querySelectorAll<HTMLElement>('.looma-line-number[data-line]'))
    .map((element) => ({
      line: Number(element.dataset.line),
      top: element.getBoundingClientRect().top - containerRect.top + container.scrollTop,
    }))
}

const getTextOffsetBeforePos = (pos: number) => {
  if (!editor.value) return 0
  return editor.value.state.doc.textBetween(0, pos, '\n', '\n').length
}

const findPosForTextOffset = (textOffset: number) => {
  const currentEditor = editor.value
  if (!currentEditor) return null
  const target = Math.max(0, Math.round(textOffset))
  let seen = 0
  let result: number | null = null

  currentEditor.state.doc.descendants((node, pos) => {
    if (!node.isText || typeof node.text !== 'string') return true
    const nextSeen = seen + node.text.length
    if (target <= nextSeen) {
      result = pos + Math.max(0, target - seen)
      return false
    }
    seen = nextSeen
    return true
  })

  return result ?? currentEditor.state.doc.content.size
}

const getPreviewScrollState = (): ScrollSyncState => {
  const container = previewContainerRef.value
  const currentEditor = editor.value
  if (!container || !currentEditor) return { ratio: 0 }

  const rect = container.getBoundingClientRect()
  const posInfo = currentEditor.view.posAtCoords({ left: rect.left + 32, top: rect.top + 4 })
  const topBlock = getTopVisibleBlock()
  const textOffset = posInfo ? getTextOffsetBeforePos(posInfo.pos) : undefined
  const sourceLine = getSourceLineAtOffset(getPreviewSourceLineAnchors(), container.scrollTop + 4) ?? undefined
  return {
    ratio: getScrollRatio(container),
    sourceLine,
    textOffset,
    sourceLineText: topBlock?.textContent || undefined,
  }
}

const emitPreviewScrollState = () => {
  scrollSyncFrame = null
  emit('scroll-sync', getPreviewScrollState())
}

const handlePreviewScroll = () => {
  if (scrollSyncFrame !== null) return
  scrollSyncFrame = requestAnimationFrame(emitPreviewScrollState)
}

const scrollToBlockText = (sourceLineText: string) => {
  const blocks = getScrollableBlocks()
  const index = findBestTextAnchor(blocks.map((block) => block.textContent || ''), sourceLineText)
  const block = index >= 0 ? blocks[index] : null
  if (!block) return false
  block.scrollIntoView({ block: 'start' })
  return true
}

/** 预览模式下按源码行号滚动：用该行文本作为块锚点。 */
const scrollToSourceLine = (line: number) => {
  const content = props.content || ''
  const lines = content.split('\n')
  const safeLine = Math.min(Math.max(Math.round(line || 1), 1), lines.length)
  const targetText = (lines[safeLine - 1] || '').trim()
  if (!targetText) return false
  return scrollToBlockText(targetText)
}

const handleNoteRefClick = (event: MouseEvent) => {
  const target = event.target as HTMLElement | null
  const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchor) return
  const href = anchor.getAttribute('href') || ''

  // 内部笔记引用：跳转到对应位置
  const ref = parseNoteLinkHref(href, props.relativeFilePath)
  if (ref) {
    event.preventDefault()
    event.stopPropagation()
    dispatchOpenNoteRef(ref)
    return
  }

  // 外部 http(s) 链接：交给系统默认浏览器，绝不在 looma 窗口内打开
  if (/^https?:/i.test(href)) {
    event.preventDefault()
    event.stopPropagation()
    void window.electronAPI.app.openExternal(href)
  }
}

/** 检测输入 [[ 并打开笔记引用选择器（光标前两个字符为 [[，且不在代码块内）。 */
const maybeOpenNoteRefPicker = (currentEditor: any) => {
  if (noteRefPickerState.value.open) return
  const { state } = currentEditor
  const { $from } = state.selection
  if ($from.parent.type.name.includes('code')) return
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\n', '')
  if (!textBefore.endsWith('[[')) return

  const { from, to } = state.selection
  const selectedText = from === to ? '' : state.doc.textBetween(from, to, '\n', '')
  const fromPos = Math.max(0, $from.pos - 2)
  currentEditor.chain().focus().deleteRange({ from: fromPos, to: $from.pos }).run()
  noteRefPickerState.value = { open: true, selectedText }
}

/** 从选择器选中笔记后插入链接（带 link mark 的文本节点，序列化时输出 [label](href)）。 */
const insertNoteRefLink = (payload: { relativePath: string; href: string; label: string }) => {
  noteRefPickerState.value = { open: false, selectedText: '' }
  const currentEditor = editor.value
  if (!currentEditor || currentEditor.isDestroyed) return
  currentEditor.chain().focus().insertContent({
    type: 'text',
    text: payload.label,
    marks: [{ type: 'link', attrs: { href: payload.href } }],
  }).run()
}

const scrollToTextOffset = (textOffset: number) => {
  const currentEditor = editor.value
  if (!currentEditor) return false
  const pos = findPosForTextOffset(textOffset)
  if (typeof pos !== 'number') return false
  currentEditor.commands.setTextSelection(pos)
  currentEditor.commands.scrollIntoView()
  return true
}

const applyPreviewScrollState = (state: ScrollSyncState) => {
  const container = previewContainerRef.value
  if (!container) return
  if (typeof state.sourceLine === 'number') {
    const offset = getOffsetForSourceLine(getPreviewSourceLineAnchors(), state.sourceLine)
    if (typeof offset === 'number') {
      container.scrollTop = offset
      return
    }
  }
  if (state.sourceLineText && scrollToBlockText(state.sourceLineText)) return
  if (typeof state.textOffset === 'number' && scrollToTextOffset(state.textOffset)) return
  setScrollRatio(container, state.ratio)
}

const clearPendingHeadingTarget = () => {
  pendingHeadingTarget = null
  if (pendingHeadingClearTimer) {
    window.clearTimeout(pendingHeadingClearTimer)
    pendingHeadingClearTimer = null
  }
}

const clearPendingMarkdownEmit = () => {
  if (!pendingMarkdownEmitTimer) return
  window.clearTimeout(pendingMarkdownEmitTimer)
  pendingMarkdownEmitTimer = null
}

const emitCurrentMarkdown = () => {
  clearPendingMarkdownEmit()
  const currentEditor = editor.value
  if (!currentEditor || isUnmounting || currentEditor.isDestroyed || isUpdatingFromExternal) return undefined

  const markdown = markdownSerializationGate.flush(() => serializeMarkdownAst(currentEditor))
  if (markdown === undefined) return undefined
  if (markdown === lastEmittedContent) return markdown
  lastEmittedContent = markdown
  emit('update:content', markdown)
  return markdown
}

const scheduleMarkdownEmit = () => {
  clearPendingMarkdownEmit()
  markdownSerializationGate.markDirty()
  pendingMarkdownEmitTimer = window.setTimeout(() => {
    pendingMarkdownEmitTimer = null
    emitCurrentMarkdown()
  }, MARKDOWN_EMIT_DEBOUNCE_MS)
}

const clearPendingCodeHighlight = () => {
  if (!pendingCodeHighlightTimer) return
  window.clearTimeout(pendingCodeHighlightTimer)
  pendingCodeHighlightTimer = null
}

const selectionIsInCodeBlock = (currentEditor: any) =>
  currentEditor.state.selection.$head.parent.type.name === CodeBlockWithHeader.name

const scheduleCodeHighlightRefresh = (currentEditor: any) => {
  clearPendingCodeHighlight()
  pendingCodeHighlightTimer = window.setTimeout(() => {
    pendingCodeHighlightTimer = null
    if (isUnmounting || currentEditor.isDestroyed) return
    currentEditor.view.dispatch(currentEditor.state.tr.setMeta(deferredLowlightKey, { force: true }))
  }, CODE_HIGHLIGHT_IDLE_MS)
}

const rememberHeadingTarget = (target: MarkdownOutlineItem) => {
  pendingHeadingTarget = target
  if (pendingHeadingClearTimer) window.clearTimeout(pendingHeadingClearTimer)
  pendingHeadingClearTimer = window.setTimeout(() => {
    pendingHeadingTarget = null
    pendingHeadingClearTimer = null
  }, HEADING_REANCHOR_WINDOW_MS)
}

const scrollToHeadingTarget = (target: MarkdownOutlineItem, behavior: ScrollBehavior) => {
  const container = previewContainerRef.value
  if (!container) return false
  const headings = Array.from(container.querySelectorAll<HTMLElement>('.tiptap h1, .tiptap h2, .tiptap h3, .tiptap h4, .tiptap h5, .tiptap h6'))
  const heading = headings[target.index]
  if (!heading) return false
  heading.scrollIntoView({ block: 'start', behavior })
  return true
}

const reanchorPendingHeading = () => {
  const target = pendingHeadingTarget
  if (!target) return
  requestAnimationFrame(() => {
    if (pendingHeadingTarget !== target) return
    scrollToHeadingTarget(target, 'auto')
  })
}

onMounted(() => {
  editor.value = new Editor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        bulletList: { keepMarks: true, keepAttributes: false },
        orderedList: { keepMarks: true, keepAttributes: false },
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
        },
      }),
      CodeBlockWithHeader.configure({
        exitOnTripleEnter: false,
        exitOnArrowDown: true,
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Highlight,
      EnhancedTable.configure({
        resizable: true,
        renderWrapper: true,
        cellMinWidth: 96,
      }),
      TableRow,
      TableHeader,
      TableCell,
      LocalImage.configure({
        inline: false,
        allowBase64: true,
      }),
      Placeholder.configure({
        placeholder: 'Shift + ctrl + Enter 唤起菜单，或直接输入 Markdown...',
      }),
      Markdown.configure({
        markedOptions: { gfm: true },
      }),
      LineNumbers,
    ],
    content: prepareMarkdownForRichText(props.content),
    contentType: 'markdown',
    editorProps: {
      attributes: {
        class: 'prose dark:prose-invert max-w-none focus:outline-hidden min-h-full p-8 markdown-body dark:markdown-body-dark',
        spellcheck: 'false',
        autocorrect: 'off',
        autocapitalize: 'off',
      },
      handleKeyDown: (_view, event) => {
        const isClipboardShortcut = isPrimaryModifierPressed(event, window.electronAPI.platform) && !event.altKey
        if (isClipboardShortcut && event.key.toLowerCase() === 'c') {
          event.preventDefault()
          void copyRichTextSelection().catch(console.error)
          return true
        }
        if (event.key !== 'Enter' || !editor.value) return false
        return renderCurrentMarkdownImage(editor.value)
      },
      handleDOMEvents: {
        copy: (_view, event) => handleClipboardCopy(event as ClipboardEvent),
      },
      handlePaste: (_view, event) => handleClipboardPaste(event),
      handleDrop: (_view, event) => {
        if (!event.dataTransfer?.types.includes('Files')) return false
        void importDroppedImages(event)
        return true
      },
    },
    onUpdate: ({ editor }) => {
      if (isUnmounting || editor.isDestroyed) return
      if (isUpdatingFromExternal) return
      maybeOpenNoteRefPicker(editor)
      scheduleMarkdownEmit()
    },
    onTransaction: ({ editor, transaction }) => {
      if (isUnmounting || editor.isDestroyed) return
      if (!transaction.docChanged) return
      if (!selectionIsInCodeBlock(editor)) return
      scheduleCodeHighlightRefresh(editor)
    },
  })

  previewContainerRef.value?.addEventListener(PREVIEW_IMAGE_SETTLED_EVENT, reanchorPendingHeading)
  previewContainerRef.value?.addEventListener('click', handleNoteRefClick, true)
  previewContainerRef.value?.addEventListener('scroll', handlePreviewScroll, { passive: true })
})

onBeforeUnmount(() => {
  emitCurrentMarkdown()
  isUnmounting = true
  previewContainerRef.value?.removeEventListener(PREVIEW_IMAGE_SETTLED_EVENT, reanchorPendingHeading)
  previewContainerRef.value?.removeEventListener('click', handleNoteRefClick, true)
  previewContainerRef.value?.removeEventListener('scroll', handlePreviewScroll)
  if (scrollSyncFrame !== null) cancelAnimationFrame(scrollSyncFrame)
  clearPendingMarkdownEmit()
  clearPendingCodeHighlight()
  clearPendingHeadingTarget()
  const currentEditor = editor.value
  editor.value = null
  destroyTiptapEditorSafely(currentEditor)
})

watch(
  () => props.content,
  (newContent) => {
    if (!editor.value) return
    if (isUnmounting || editor.value.isDestroyed) return
    if (pendingMarkdownEmitTimer) {
      if (editor.value.isFocused) emitCurrentMarkdown()
      else {
        clearPendingMarkdownEmit()
        markdownSerializationGate.clear()
      }
    }
    if (newContent === lastEmittedContent) return

    const scrollState = getPreviewScrollState()
    isUpdatingFromExternal = true
    clearPendingCodeHighlight()
    const { from, to } = editor.value.state.selection
    markdownSerializationGate.clear()
    replaceExternalMarkdownContent(editor.value as any, prepareMarkdownForRichText(newContent))
    
    // Try to restore selection if possible
    try {
      editor.value.commands.setTextSelection({ from, to })
    } catch (e) {
      // Ignore
    }
    
    nextTick(() => {
      requestAnimationFrame(() => {
        applyPreviewScrollState(scrollState)
        isUpdatingFromExternal = false
      })
    })
  }
)

defineExpose({
  scrollToHeading(target: MarkdownOutlineItem) {
    if (scrollToHeadingTarget(target, 'smooth')) rememberHeadingTarget(target)
  },
  scrollToLine(line: number) {
    return scrollToSourceLine(line)
  },
  getScrollState() {
    return getPreviewScrollState()
  },
  applyScrollState(state: ScrollSyncState) {
    applyPreviewScrollState(state)
  },
  flushPendingMarkdownEmit() {
    return emitCurrentMarkdown()
  },
})


</script>

<template>
  <div
    ref="previewContainerRef"
    class="h-full w-full bg-panel overflow-y-auto relative tiptap-preview-container tiptap-editor-wrapper focus-scrollbar"
    @dragover="handleExternalImageDragOver"
  >
    <editor-content v-if="editor" :editor="editor" class="h-full" />
    
    <InlineMenu v-if="editor" :editor="editor" @insert-image="imageInsertDialogOpen = true" />
    <ContextMenu
      v-if="editor"
      :editor="editor"
      :relative-file-path="props.relativeFilePath"
      @insert-image="imageInsertDialogOpen = true"
      @copy="(text) => copyRichTextSelection(text).catch(console.error)"
      @copy-source="(text) => copyRichTextSource(text).catch(console.error)"
      @paste="pasteRichTextClipboard().catch(console.error)"
    />
    <TableToolbar v-if="editor" :editor="editor" />
    <NoteRefPicker
      v-if="noteRefPickerState.open"
      :from-relative-path="props.relativeFilePath"
      :selected-text="noteRefPickerState.selectedText"
      @select="insertNoteRefLink"
      @close="noteRefPickerState = { open: false, selectedText: '' }; editor?.commands.focus()"
    />
    <ImageInsertDialog
      v-if="editor"
      :open="imageInsertDialogOpen"
      :editor="editor"
      :file-path="filePath"
      @close="imageInsertDialogOpen = false"
    />
    <EditorDropAlert
      :open="Boolean(dropErrorMessage)"
      :message="dropErrorMessage"
      :detail="dropTechnicalDetail"
      @close="clearDropError"
    />
  </div>
</template>

<style>
.tiptap-preview-container {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}

/* ---- Tiptap 行号 ---- */
.tiptap-preview-container .ProseMirror {
  position: relative;
  /* 覆盖 Tailwind p-8 的 padding-left，为行号栏留出空间 */
  padding-left: 3rem;
}

.tiptap-preview-container .looma-line-number {
  position: absolute;
  left: 0.5rem;
  min-width: 2.25rem;
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.72rem;
  line-height: inherit;
  color: var(--text-subtle);
  white-space: nowrap;
  user-select: none;
  -webkit-user-select: none;
  pointer-events: none;
  cursor: default;
  /* 小字号的视觉中心原先比正文偏上，向下微调后与正文行盒居中。 */
  transform: translateY(0.16rem);
  transition: opacity 0.12s ease;
}

.tiptap-preview-container .looma-line-number-active {
  color: var(--text-main);
  font-weight: 700;
}

.tiptap-preview-container .looma-active-line {
  background: var(--editor-active-line-bg);
  box-shadow: -100vw 0 0 var(--editor-active-line-bg);
}

/* 行内菜单 "+" 按钮出现时，当前行行号隐藏（断点化占位） */
.tiptap-preview-container .looma-line-number.looma-line-number-hidden {
  opacity: 0;
}

/* 表格内部不渲染行号（单元格自带定位上下文且会裁剪，行号没有意义） */
.tiptap-preview-container table .looma-line-number {
  display: none;
}

/* 代码块行号：跟随代码块自身的左内边距，避免被 code-block-shell 的定位上下文干扰 */
.tiptap-preview-container .code-block-content {
  position: relative;
  padding-left: 3rem;
}

.tiptap-preview-container .code-block-content .looma-line-number {
  left: 0;
}
.markdown-body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  line-height: 1.6;
  color: var(--text-main);
  background-color: transparent !important;
  padding-bottom: calc(2rem + 22vh) !important;
}

.markdown-body a {
  color: var(--accent);
}

[data-theme="dark"] .markdown-body,
.dark .markdown-body {
  color: var(--text-main);
  background-color: transparent !important;
}

.markdown-body p {
  margin-bottom: 0.6em;
}

.tiptap img,
.markdown-body img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0.85em 0;
  border-radius: 6px;
}

.tiptap pre,
.markdown-body pre {
  margin: 0.85em 0;
  padding: 0.85rem 1rem;
  min-height: 2.75rem;
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  color: var(--text-main);
  background: var(--panel-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.92em;
  line-height: 1.55;
}

.tiptap pre code,
.markdown-body pre code {
  margin: 0;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  tab-size: 2;
}

.tiptap pre code:empty::before {
  content: "\200b";
}

.tiptap pre code br.ProseMirror-trailingBreak {
  display: inline;
}

.tiptap h1::after,
.tiptap h2::after,
.tiptap h3::after,
.tiptap h4::after,
.tiptap h5::after,
.tiptap h6::after,
.markdown-body h1::after,
.markdown-body h2::after,
.markdown-body h3::after,
.markdown-body h4::after,
.markdown-body h5::after,
.markdown-body h6::after {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 0.5rem;
  padding: 0.05rem 0.3rem;
  min-width: 1.35rem;
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  color: var(--text-muted);
  background: var(--panel-soft);
  font-size: 0.65rem;
  font-weight: 600;
  line-height: 1.2;
  vertical-align: middle;
  visibility: hidden;
  opacity: 0;
  transition: opacity 120ms ease;
  pointer-events: none;
  user-select: none;
}

.tiptap h1:hover::after,
.tiptap h2:hover::after,
.tiptap h3:hover::after,
.tiptap h4:hover::after,
.tiptap h5:hover::after,
.tiptap h6:hover::after,
.tiptap h1:focus-within::after,
.tiptap h2:focus-within::after,
.tiptap h3:focus-within::after,
.tiptap h4:focus-within::after,
.tiptap h5:focus-within::after,
.tiptap h6:focus-within::after,
.markdown-body h1:hover::after,
.markdown-body h2:hover::after,
.markdown-body h3:hover::after,
.markdown-body h4:hover::after,
.markdown-body h5:hover::after,
.markdown-body h6:hover::after,
.markdown-body h1:focus-within::after,
.markdown-body h2:focus-within::after,
.markdown-body h3:focus-within::after,
.markdown-body h4:focus-within::after,
.markdown-body h5:focus-within::after,
.markdown-body h6:focus-within::after {
  visibility: visible;
  opacity: 1;
}

.tiptap h1::after,
.markdown-body h1::after {
  content: "H1";
}
.tiptap h2::after,
.markdown-body h2::after {
  content: "H2";
}
.tiptap h3::after,
.markdown-body h3::after {
  content: "H3";
}
.tiptap h4::after,
.markdown-body h4::after {
  content: "H4";
}
.tiptap h5::after,
.markdown-body h5::after {
  content: "H5";
}
.tiptap h6::after,
.markdown-body h6::after {
  content: "H6";
}

.markdown-body-dark {
  background-color: transparent !important;
}
.tiptap p.is-editor-empty:first-child::before {
  color: var(--text-subtle);
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
}
.tiptap .tableWrapper,
.markdown-body .tableWrapper {
  width: 100%;
  margin: 0.95em 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

.tiptap table,
.markdown-body table {
  width: max-content;
  min-width: 100%;
  margin: 0;
  border-collapse: collapse;
  table-layout: auto;
  overflow: visible;
}

.tiptap table td,
.tiptap table th,
.markdown-body table td,
.markdown-body table th {
  min-width: 7.5rem;
  border: 1px solid var(--border-soft);
  padding: 0.5rem 0.65rem;
  vertical-align: top;
  white-space: nowrap;
  box-sizing: border-box;
  position: relative;
  background: var(--panel);
}

.tiptap table td p,
.tiptap table th p,
.markdown-body table td p,
.markdown-body table th p {
  margin: 0;
  white-space: inherit;
}
.tiptap table th {
  font-weight: bold;
  text-align: left;
  background-color: var(--panel-soft);
}
.tiptap table .selectedCell::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 1;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  pointer-events: none;
}
.tiptap table .column-resize-handle {
  position: absolute;
  top: 0;
  right: -2px;
  bottom: -1px;
  z-index: 2;
  width: 4px;
  background: var(--accent);
  pointer-events: none;
}
.tiptap.resize-cursor,
.tiptap.resize-cursor * {
  cursor: col-resize;
}
[data-theme="dark"] .tiptap table td,
[data-theme="dark"] .tiptap table th,
.dark .tiptap table td,
.dark .tiptap table th {
  border-color: var(--border-soft);
}
[data-theme="dark"] .tiptap table th,
.dark .tiptap table th {
  background-color: var(--panel-soft);
}
.tiptap ul, .markdown-body ul {
  list-style-type: disc;
  padding-left: 1.5rem;
  margin-top: 0.5em;
  margin-bottom: 0.5em;
}
.tiptap ul ul, .markdown-body ul ul {
  list-style-type: circle;
}
.tiptap ul ul ul, .markdown-body ul ul ul {
  list-style-type: square;
}
.tiptap ol, .markdown-body ol {
  list-style-type: decimal;
  padding-left: 1.5rem;
  margin-top: 0.5em;
  margin-bottom: 0.5em;
}
.tiptap ol ol, .markdown-body ol ol {
  list-style-type: lower-alpha;
}
.tiptap ol ol ol, .markdown-body ol ol ol {
  list-style-type: lower-roman;
}
.tiptap li, .markdown-body li {
  display: list-item;
}
.tiptap li::marker, .markdown-body li::marker {
  color: inherit;
}
.tiptap li p, .markdown-body li p {
  margin: 0;
}
.tiptap ul[data-type="taskList"], .markdown-body ul[data-type="taskList"] {
  list-style: none;
  padding: 0;
}
.tiptap ul[data-type="taskList"] p {
  margin: 0;
}
.tiptap ul[data-type="taskList"] li {
  display: flex;
}
.tiptap ul[data-type="taskList"] li > label {
  flex: 0 0 auto;
  margin-right: 0.5rem;
  user-select: none;
  display: flex;
  align-items: center;
}
.tiptap ul[data-type="taskList"] li > label input[type="checkbox"] {
  margin: 0;
  cursor: pointer;
}
.tiptap ul[data-type="taskList"] li > div {
  flex: 1 1 auto;
}
</style>
