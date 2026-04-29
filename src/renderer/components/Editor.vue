<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorState } from '@codemirror/state';
import { useWorkspaceStore } from '../store/workspace';

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

const createEditor = () => {
  if (!editorContainer.value) return;

  const updateListener = EditorView.updateListener.of((update) => {
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

  const themeExtension = workspaceStore.theme === 'dark' ? [oneDark] : [];

  const langExtension = props.mode === 'markdown' ? [markdown()] : [];

  const state = EditorState.create({
    doc: props.initialContent,
    extensions: [
      basicSetup,
      ...langExtension,
      ...themeExtension,
      updateListener,
      blurHandler,
      EditorView.lineWrapping,
      EditorView.theme({
        '&': { height: '100%', fontSize: `${props.fontSize}px` },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, Monaco, monospace' },
        '.cm-content': { 
          padding: '10px 0',
          whiteSpace: props.wordWrap ? 'pre-wrap' : 'pre'
        },
      }),
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
      editor.destroy();
      createEditor();
    }
  }
);
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
