<script setup lang="ts">
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import CodeBlockCopy from '../shared/CodeBlockCopy.vue'
import '../shared/code-block-presentation.css'

const props = defineProps(nodeViewProps)
const readCode = () => props.node.textContent
</script>

<template>
  <NodeViewWrapper class="code-block-shell">
    <CodeBlockCopy :language="typeof node.attrs.language === 'string' ? node.attrs.language : ''" :get-text="readCode" />
    <pre class="code-block-body"><NodeViewContent as="code" class="code-block-content code-block-syntax" /></pre>
  </NodeViewWrapper>
</template>
