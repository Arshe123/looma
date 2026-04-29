<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import 'github-markdown-css/github-markdown-light.css';
import 'highlight.js/styles/github-dark.css';
import { Copy, Check } from 'lucide-vue-next';

const props = defineProps<{
  content: string;
}>();

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: function (str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang }).value;
      } catch (__) {}
    }
    return ''; // use external default escaping
  }
});

const renderedHtml = computed(() => {
  return md.render(props.content);
});

const previewContainer = ref<HTMLElement | null>(null);
const copied = ref(false);

const handleCopy = async () => {
  try {
    await navigator.clipboard.writeText(props.content);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy text: ', err);
  }
};
</script>

<template>
  <div class="h-full w-full bg-white dark:bg-zinc-900 overflow-y-auto p-8 relative scroll-smooth group">
    <button 
      @click="handleCopy"
      class="absolute top-4 right-4 p-2 bg-white/80 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 rounded-md shadow-sm opacity-0 group-hover:opacity-100 transition-opacity z-10"
      title="Copy Markdown"
    >
      <Check v-if="copied" :size="18" class="text-green-500" />
      <Copy v-else :size="18" class="text-zinc-500" />
    </button>
    
    <div 
      ref="previewContainer"
      class="markdown-body dark:markdown-body-dark max-w-none prose dark:prose-invert"
      v-html="renderedHtml"
    ></div>
  </div>
</template>

<style>
.markdown-body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  line-height: 1.6;
  color: #1b1b1b;
}

.dark .markdown-body {
  color: #d4d4d4;
  background-color: transparent !important;
}

.markdown-body p {
  margin-bottom: 0.6em;
}

.markdown-body-dark {
  background-color: transparent !important;
}
</style>
