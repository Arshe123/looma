<script setup lang="ts">
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { computed, ref, watchEffect } from 'vue'
import CodeBlockCopy from '../shared/CodeBlockCopy.vue'
import { isMermaidLanguage, mountMermaidPreview } from '../shared/mermaid-preview'
import '../shared/code-block-presentation.css'

const props = defineProps(nodeViewProps)
const readCode = () => props.node.textContent
const isMermaid = computed(() => isMermaidLanguage(props.node.attrs.language))
const diagram = ref<HTMLElement | null>(null)
watchEffect((onCleanup) => {
  if (isMermaid.value && diagram.value) onCleanup(mountMermaidPreview(diagram.value, readCode()))
}, { flush: 'post' })
</script>

<template>
  <NodeViewWrapper class="code-block-shell">
    <CodeBlockCopy :language="typeof node.attrs.language === 'string' ? node.attrs.language : ''" :get-text="readCode" />
    <div v-if="isMermaid" ref="diagram" class="looma-mermaid-preview" contenteditable="false" hidden />
    <pre class="code-block-body" :hidden="isMermaid"><NodeViewContent as="code" class="code-block-content code-block-syntax" /></pre>
  </NodeViewWrapper>
</template>
