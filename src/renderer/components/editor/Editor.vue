<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { codeFolding } from '@codemirror/language';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { useWorkspaceStore } from '../../stores/workspace';
import {
  findBestTextAnchor,
  getScrollRatio,
  lineTextAtOffset,
  setScrollRatio,
} from '@/shared/utils/editor-scroll-sync';
import type { ScrollSyncState } from '@/shared/types/ScrollSyncState'
import { getDroppedFilePaths, isSupportedDroppedImagePath } from '@/shared/utils/external-file-drop'
import { formatMarkdownImage } from '@/shared/utils/tiptap-image-insertion'
import EditorDropAlert from './EditorDropAlert.vue'

const props = withDefaults(defineProps<{
  initialContent: string;
  filePath: string;
  relativeFilePath?: string;
  mode?: 'markdown' | 'plaintext';
  fontSize?: number;
  wordWrap?: boolean;
}>(), {
  mode: 'markdown',
  fontSize: 14,
  wordWrap: true,
});

const emit = defineEmits<{
  (e: 'change', value: string): void
  (e: 'save', value: string): void
  (e: 'scroll-sync', value: ScrollSyncState): void
}>();

const editorContainer = ref<HTMLElement | null>(null);
const workspaceStore = useWorkspaceStore();
const dropErrorMessage = ref('');
const dropTechnicalDetail = ref('');
let editor: EditorView | null = null;
let saveTimeout: any = null;
let applyingExternalUpdate = false;
let scrollSyncFrame: number | null = null;
let scrollApplyFrame: number | null = null;

// Compartments for dynamic reconfiguration without destroying editor
const themeCompartment = new Compartment()
const langCompartment = new Compartment()
const lineWrapCompartment = new Compartment()
const customStyleCompartment = new Compartment()

const getThemeExtension = () => [];
const getLangExtension = () => props.mode === 'markdown' ? [markdown()] : [];
const getLineWrapExtension = () => props.wordWrap ? [EditorView.lineWrapping] : [];
const editorContentAttributes = EditorView.contentAttributes.of({
  spellcheck: 'false',
  autocorrect: 'off',
  autocapitalize: 'off',
})
const BASE_BOTTOM_SPACER = '22vh'
const SVG_NS = 'http://www.w3.org/2000/svg'
const createFoldPlaceholder = (_view: EditorView, onclick: (event: Event) => void) => {
  const element = document.createElement('span')
  element.className = 'cm-foldPlaceholder'
  element.title = 'unfold'
  element.setAttribute('aria-label', 'folded code')
  element.onclick = onclick

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('xmlns', SVG_NS)
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')

  for (const d of ['M12 12h.01', 'M16 12h.01', 'm17 7 5 5-5 5', 'm7 7-5 5 5 5', 'M8 12h.01']) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }

  element.appendChild(svg)
  return element
}
const getCustomStyleExtension = () => {
  return EditorView.theme({
    '&': { height: '100%', fontSize: `${props.fontSize}px`, backgroundColor: 'var(--surface)', color: 'var(--text-main)' },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'Consolas, Monaco, monospace',
      scrollbarWidth: 'thin',
      scrollbarColor: 'transparent transparent',
      backgroundColor: 'var(--surface)',
    },
    '.cm-scroller::-webkit-scrollbar': { width: '8px', height: '8px' },
    '.cm-scroller::-webkit-scrollbar-track': { background: 'transparent' },
    '.cm-scroller::-webkit-scrollbar-thumb': {
      backgroundColor: 'transparent',
      borderRadius: '4px',
    },
    '&:hover .cm-scroller, &.cm-focused .cm-scroller': {
      scrollbarColor: 'var(--scrollbar-thumb) transparent',
    },
    '&:hover .cm-scroller::-webkit-scrollbar-thumb, &.cm-focused .cm-scroller::-webkit-scrollbar-thumb': {
      backgroundColor: 'var(--scrollbar-thumb)',
    },
    '.cm-scroller::-webkit-scrollbar-thumb:hover': {
      backgroundColor: 'var(--scrollbar-thumb-hover)',
    },
    '.cm-content': {
      padding: `10px 0 ${BASE_BOTTOM_SPACER} 0`,
      whiteSpace: props.wordWrap ? 'pre-wrap' : 'pre'
    },
    '.cm-activeLine': {
      backgroundColor: 'var(--editor-active-line-bg)',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--text-subtle)',
      border: 'none',
      minWidth: '44px',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 10px 0 8px',
      fontSize: `${props.fontSize - 1}px`,
      fontFamily: 'Consolas, Monaco, monospace',
    },
    '.cm-activeLineGutter': {
      color: 'var(--text-main)',
      fontWeight: '600',
      backgroundColor: 'transparent',
    },
    '&.cm-focused .cm-activeLineGutter, .cm-gutters .cm-lineNumbers .cm-gutterElement.cm-activeLineGutter, .cm-gutters .cm-gutterElement.cm-activeLineGutter': {
      backgroundColor: 'transparent',
    },
    '.cm-foldGutter': {
      width: '16px',
    },
    '.cm-foldGutter .cm-gutterElement': {
      opacity: 0,
      pointerEvents: 'none',
      transition: 'opacity .12s ease',
      color: 'var(--text-subtle)',
      fontSize: '12px',
      cursor: 'pointer',
    },
    '& .cm-gutters:hover .cm-foldGutter .cm-gutterElement, .cm-foldGutter .cm-gutterElement:has(span[title="Unfold line"])': {
      opacity: 1,
      pointerEvents: 'auto',
    },
    '.cm-foldPlaceholder': {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      verticalAlign: 'middle',
      width: '18px',
      height: '18px',
      margin: '0 2px',
      padding: '0',
      backgroundColor: 'var(--panel-soft)',
      border: '1px solid var(--border-soft)',
      color: 'var(--text-muted)',
      borderRadius: '4px',
      cursor: 'pointer',
    },
    '.cm-foldPlaceholder svg': {
      display: 'block',
      flexShrink: 0,
    },
  })
}

const CURSOR_BOTTOM_THRESHOLD_PX = 120
const ensureCursorComfort = (view: EditorView) => {
  if (!view.hasFocus) return

  const cursorPos = view.state.selection.main.head
  const scrollerRect = view.scrollDOM.getBoundingClientRect()

  let cursorRect = view.coordsAtPos(cursorPos)
  if (!cursorRect && cursorPos > 0) {
    cursorRect = view.coordsAtPos(cursorPos - 1)
  }
  if (!cursorRect) return

  const distanceToBottom = scrollerRect.bottom - cursorRect.bottom
  if (distanceToBottom < CURSOR_BOTTOM_THRESHOLD_PX) {
    const delta = CURSOR_BOTTOM_THRESHOLD_PX - distanceToBottom
    view.scrollDOM.scrollTop += Math.ceil(delta)
  }
}

const importDroppedImages = async (event: DragEvent, insertAt: number) => {
  event.preventDefault()
  dropErrorMessage.value = ''
  dropTechnicalDetail.value = ''
  const workspaceId = workspaceStore.activeWorkspaceId
  if (!editor || !workspaceId || !props.relativeFilePath) return

  const sourcePaths = getDroppedFilePaths(event.dataTransfer?.files)
  if (sourcePaths.length === 0) {
    dropErrorMessage.value = '无法读取拖入图片，请从系统文件资源管理器重新拖入。'
    dropTechnicalDetail.value = 'Electron did not expose native paths for the dropped File objects.'
    return
  }
  const unsupported = sourcePaths.filter(path => !isSupportedDroppedImagePath(path))
  if (unsupported.length > 0) {
    dropErrorMessage.value = '这里只能拖入 PNG、JPG、GIF、WebP 或 SVG 图片。'
    dropTechnicalDetail.value = `Unsupported paths: ${unsupported.join(', ')}`
    return
  }

  const imported: Array<{ relativePath: string; fileName: string }> = []
  const failures: string[] = []
  workspaceStore.setBusy(true, sourcePaths.length > 1 ? `正在导入 ${sourcePaths.length} 张图片...` : '正在导入图片...')
  try {
    for (const sourcePath of sourcePaths) {
      const result = await window.electronAPI.fs.importImage(workspaceId, props.relativeFilePath, sourcePath)
      if (result.success && result.data) imported.push(result.data)
      else failures.push(result.error || sourcePath)
    }
    if (editor && imported.length > 0) {
      const markdownImages = imported.map(image => formatMarkdownImage({
        alt: image.fileName,
        src: image.relativePath,
      })).join('\n\n')
      const safePosition = Math.min(Math.max(insertAt, 0), editor.state.doc.length)
      editor.dispatch({
        changes: { from: safePosition, insert: markdownImages },
        selection: { anchor: safePosition + markdownImages.length },
      })
      editor.focus()
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

const clearDropError = () => {
  dropErrorMessage.value = ''
  dropTechnicalDetail.value = ''
}

const createEditor = () => {
  if (!editorContainer.value) return;

  const updateListener = EditorView.updateListener.of((update) => {
    if ((update.docChanged || update.selectionSet) && update.view.hasFocus) {
      ensureCursorComfort(update.view);
    }

    if (update.docChanged) {
      if (applyingExternalUpdate) return;
      const content = update.state.doc.toString();
      emit('change', content);
      
      // Auto-save logic: after 1s of stopping input
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        emit('save', content);
      }, 1000);
    }
  });

  const domEventHandlers = EditorView.domEventHandlers({
    blur: () => {
      if (!editor) return;
      const content = editor.state.doc.toString();
      emit('save', content);
    },
    dragover: (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return false
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      return true
    },
    drop: (event, view) => {
      if (!event.dataTransfer?.types.includes('Files')) return false
      const insertAt = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
      void importDroppedImages(event, insertAt)
      return true
    },
  });

  const state = EditorState.create({
    doc: props.initialContent,
    extensions: [
      basicSetup,
      codeFolding({ placeholderDOM: createFoldPlaceholder }),
      keymap.of([indentWithTab]),
      langCompartment.of(getLangExtension()),
      themeCompartment.of(getThemeExtension()),
      lineWrapCompartment.of(getLineWrapExtension()),
      customStyleCompartment.of(getCustomStyleExtension()),
      editorContentAttributes,
      updateListener,
      domEventHandlers,
    ],
  });

  editor = new EditorView({
    state,
    parent: editorContainer.value,
  });
  editor.scrollDOM.addEventListener('scroll', handleEditorScroll, { passive: true })
};

const getEditorScrollState = (): ScrollSyncState => {
  if (!editor) return { ratio: 0 }
  const rect = editor.scrollDOM.getBoundingClientRect()
  const sourceOffset = editor.posAtCoords({ x: rect.left + 52, y: rect.top + 4 }) ?? editor.state.selection.main.head
  const viewportHeight = rect.top + 4 - editor.documentTop
  const sourceLineBlock = editor.lineBlockAtHeight(viewportHeight)
  const sourceLineInfo = editor.state.doc.lineAt(sourceLineBlock.from)
  const sourceLineProgress = sourceLineBlock.height > 0
    ? Math.min(Math.max((viewportHeight - sourceLineBlock.top) / sourceLineBlock.height, 0), 1)
    : 0
  return {
    ratio: getScrollRatio(editor.scrollDOM),
    sourceLine: sourceLineInfo.number + sourceLineProgress,
    sourceOffset,
    sourceLineText: lineTextAtOffset(editor.state.doc.toString(), sourceOffset),
  }
}

const emitEditorScrollState = () => {
  scrollSyncFrame = null
  emit('scroll-sync', getEditorScrollState())
}

const handleEditorScroll = () => {
  if (scrollSyncFrame !== null) return
  scrollSyncFrame = requestAnimationFrame(emitEditorScrollState)
}

const scrollToSourceOffset = (sourceOffset: number) => {
  if (!editor) return false
  const docLength = editor.state.doc.length
  const safeOffset = Math.min(Math.max(Math.round(sourceOffset), 0), docLength)
  editor.dispatch({
    effects: EditorView.scrollIntoView(safeOffset, { y: 'start' }),
  })
  return true
}

const scrollToSourceLine = (sourceLine: number) => {
  if (!editor || !Number.isFinite(sourceLine)) return false
  const lineNumber = Math.min(Math.max(Math.floor(sourceLine), 1), editor.state.doc.lines)
  const fraction = Math.min(Math.max(sourceLine - Math.floor(sourceLine), 0), 1)
  const alignSourceLine = () => {
    if (!editor) return
    const line = editor.state.doc.line(lineNumber)
    const block = editor.lineBlockAt(line.from)
    const rect = editor.scrollDOM.getBoundingClientRect()
    const viewportHeight = rect.top + 4 - editor.documentTop
    const targetHeight = block.top + block.height * fraction
    editor.scrollDOM.scrollTop += targetHeight - viewportHeight
  }
  alignSourceLine()
  if (scrollApplyFrame !== null) cancelAnimationFrame(scrollApplyFrame)
  scrollApplyFrame = requestAnimationFrame(() => {
    scrollApplyFrame = null
    alignSourceLine()
  })
  return true
}

const scrollToSourceLineText = (sourceLineText: string) => {
  if (!editor) return false
  const content = editor.state.doc.toString()
  const lines = content.split('\n')
  const index = findBestTextAnchor(lines, sourceLineText)
  if (index < 0) return false
  const line = editor.state.doc.line(index + 1)
  return scrollToSourceOffset(line.from)
}

const applyEditorScrollState = (state: ScrollSyncState) => {
  if (!editor) return
  if (typeof state.sourceLine === 'number' && scrollToSourceLine(state.sourceLine)) return
  if (typeof state.sourceOffset === 'number' && scrollToSourceOffset(state.sourceOffset)) return
  if (state.sourceLineText && scrollToSourceLineText(state.sourceLineText)) return
  setScrollRatio(editor.scrollDOM, state.ratio)
}

onMounted(() => {
  createEditor();
});

onUnmounted(() => {
  if (editor) {
    editor.scrollDOM.removeEventListener('scroll', handleEditorScroll)
    editor.destroy();
  }
  if (scrollSyncFrame !== null) cancelAnimationFrame(scrollSyncFrame)
  if (scrollApplyFrame !== null) cancelAnimationFrame(scrollApplyFrame)
  if (saveTimeout) clearTimeout(saveTimeout);
});

watch(
  () => [props.filePath, props.initialContent] as const,
  ([, nextContent]) => {
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === nextContent) return;
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    applyingExternalUpdate = true;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: nextContent },
    });
    applyingExternalUpdate = false;
  },
);

// Reconfigure editor when mode, wrapping, sizing, or resolved tokens change.
watch(
  () => [workspaceStore.resolvedTheme, props.mode, props.fontSize, props.wordWrap],
  () => {
    if (editor) {
      editor.dispatch({
        effects: [
          themeCompartment.reconfigure(getThemeExtension()),
          langCompartment.reconfigure(getLangExtension()),
          lineWrapCompartment.reconfigure(getLineWrapExtension()),
          customStyleCompartment.reconfigure(getCustomStyleExtension())
        ]
      })
    }
  }
);

defineExpose({
  getSnapshot() {
    if (!editor) return null;
    return {
      anchor: editor.state.selection.main.anchor,
      head: editor.state.selection.main.head,
      scrollTop: editor.scrollDOM.scrollTop
    }
  },
  getScrollState() {
    return getEditorScrollState()
  },
  applyScrollState(state: ScrollSyncState) {
    applyEditorScrollState(state)
  },
  applySnapshot(snap: { anchor: number, head: number, scrollTop: number }) {
    if (!editor || !snap) return;
    
    const docLength = editor.state.doc.length;
    const safeAnchor = Math.min(snap.anchor, docLength);
    const safeHead = Math.min(snap.head, docLength);

    editor.dispatch({
      selection: { anchor: safeAnchor, head: safeHead }
    });

    requestAnimationFrame(() => {
      if (editor) {
        editor.scrollDOM.scrollTop = snap.scrollTop;
      }
    });
  },
  scrollToLine(line: number) {
    if (!editor) return;
    const safeLine = Math.min(Math.max(Math.round(line || 1), 1), editor.state.doc.lines);
    const lineInfo = editor.state.doc.line(safeLine);
    editor.dispatch({
      selection: { anchor: lineInfo.from },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: 'start' }),
    });
    editor.focus();
  }
});
</script>

<template>
  <div class="relative h-full w-full bg-surface border-r border-border-soft flex flex-col">
    <div ref="editorContainer" class="flex-1 overflow-hidden h-full"></div>
    <EditorDropAlert
      :open="Boolean(dropErrorMessage)"
      :message="dropErrorMessage"
      :detail="dropTechnicalDetail"
      @close="clearDropError"
    />
  </div>
</template>

<style>
.cm-editor {
  height: 100%;
}
.cm-scroller {
  line-height: 1.6;
}
</style>
