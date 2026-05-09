<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorState, Compartment } from '@codemirror/state';
import { useWorkspaceStore } from '../../store/workspace';

const props = withDefaults(defineProps<{
  initialContent: string;
  filePath: string;
  mode?: 'markdown' | 'plaintext';
  fontSize?: number;
  wordWrap?: boolean;
}>(), {
  mode: 'markdown',
  fontSize: 14,
  wordWrap: true,
});

const emit = defineEmits(['change', 'save']);

const editorContainer = ref<HTMLElement | null>(null);
const workspaceStore = useWorkspaceStore();
let editor: EditorView | null = null;
let saveTimeout: any = null;
let applyingExternalUpdate = false;

// Compartments for dynamic reconfiguration without destroying editor
const themeCompartment = new Compartment()
const langCompartment = new Compartment()
const lineWrapCompartment = new Compartment()
const customStyleCompartment = new Compartment()

const getThemeExtension = () => workspaceStore.theme === 'dark' ? [oneDark] : [];
const getLangExtension = () => props.mode === 'markdown' ? [markdown()] : [];
const getLineWrapExtension = () => props.wordWrap ? [EditorView.lineWrapping] : [];
const BASE_BOTTOM_SPACER = '22vh'
const getCustomStyleExtension = () => EditorView.theme({
  '&': { height: '100%', fontSize: `${props.fontSize}px` },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'Consolas, Monaco, monospace',
    scrollbarWidth: 'thin',
    scrollbarColor: 'transparent transparent',
  },
  '.cm-scroller::-webkit-scrollbar': { width: '8px', height: '8px' },
  '.cm-scroller::-webkit-scrollbar-track': { background: 'transparent' },
  '.cm-scroller::-webkit-scrollbar-thumb': {
    backgroundColor: 'transparent',
    borderRadius: '4px',
  },
  '&:hover .cm-scroller, &.cm-focused .cm-scroller': {
    scrollbarColor: workspaceStore.theme === 'dark' ? '#52525b transparent' : '#d4d4d8 transparent',
  },
  '&:hover .cm-scroller::-webkit-scrollbar-thumb, &.cm-focused .cm-scroller::-webkit-scrollbar-thumb': {
    backgroundColor: workspaceStore.theme === 'dark' ? '#52525b' : '#d4d4d8',
  },
  '.cm-scroller::-webkit-scrollbar-thumb:hover': {
    backgroundColor: workspaceStore.theme === 'dark' ? '#71717a' : '#a1a1aa',
  },
  '.cm-content': { 
    padding: `10px 0 ${BASE_BOTTOM_SPACER} 0`,
    whiteSpace: props.wordWrap ? 'pre-wrap' : 'pre'
  },
})

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

  const blurHandler = EditorView.domEventHandlers({
    blur: () => {
      if (!editor) return;
      const content = editor.state.doc.toString();
      emit('save', content);
    },
  });

  const state = EditorState.create({
    doc: props.initialContent,
    extensions: [
      basicSetup,
      langCompartment.of(getLangExtension()),
      themeCompartment.of(getThemeExtension()),
      lineWrapCompartment.of(getLineWrapExtension()),
      customStyleCompartment.of(getCustomStyleExtension()),
      updateListener,
      blurHandler,
    ],
  });

  editor = new EditorView({
    state,
    parent: editorContainer.value,
  });
};

onMounted(() => {
  createEditor();
});

onUnmounted(() => {
  if (editor) {
    editor.destroy();
  }
  if (saveTimeout) clearTimeout(saveTimeout);
});

watch(
  () => [props.filePath, props.initialContent] as const,
  ([, nextContent]) => {
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === nextContent) return;
    applyingExternalUpdate = true;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: nextContent },
    });
    applyingExternalUpdate = false;
  },
);

// Re-create editor when theme, mode, or wrap settings change
watch(
  () => [workspaceStore.theme, props.mode, props.fontSize, props.wordWrap],
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
  }
});
</script>

<template>
  <div class="h-full w-full bg-white dark:bg-[#1e1e1e] border-r border-zinc-200 dark:border-zinc-800 flex flex-col">
    <div ref="editorContainer" class="flex-1 overflow-hidden h-full"></div>
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
