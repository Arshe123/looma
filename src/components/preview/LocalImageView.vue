<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

const props = defineProps(nodeViewProps)

type ImageLoadState = 'idle' | 'loading' | 'ready' | 'failed'
const PREVIEW_IMAGE_SETTLED_EVENT = 'looma:preview-image-settled'

const renderedSrc = ref('')
const loadState = ref<ImageLoadState>('idle')
const wrapperRef = ref<any | null>(null)
let resolveRunId = 0

const originalSrc = computed(() => (
  typeof props.node.attrs.src === 'string' ? props.node.attrs.src : ''
))

const altText = computed(() => (
  typeof props.node.attrs.alt === 'string' ? props.node.attrs.alt : ''
))

const titleText = computed(() => (
  typeof props.node.attrs.title === 'string' ? props.node.attrs.title : ''
))

const width = computed(() => props.node.attrs.width ?? undefined)
const height = computed(() => props.node.attrs.height ?? undefined)

const getWrapperElement = () => {
  const value = wrapperRef.value
  return (value?.$el || value) as HTMLElement | null
}

const notifyImageSettled = () => {
  nextTick(() => {
    const element = getWrapperElement()
    if (!element) return
    element.dispatchEvent(new CustomEvent(PREVIEW_IMAGE_SETTLED_EVENT, {
      bubbles: true,
      composed: true,
    }))
  })
}

const resolveImage = async (src: string) => {
  const runId = ++resolveRunId
  renderedSrc.value = ''

  if (!src.trim()) {
    loadState.value = 'failed'
    notifyImageSettled()
    return
  }

  const resolver = (
    (props.editor.storage as any).image?.resolveImageSrc
    || (props.extension.storage as any)?.resolveImageSrc
  ) as
    | ((src: string) => Promise<string | null>)
    | undefined

  if (!resolver) {
    renderedSrc.value = src
    loadState.value = 'ready'
    return
  }

  loadState.value = 'loading'

  try {
    const nextSrc = await resolver(src)
    if (runId !== resolveRunId) return

    if (!nextSrc) {
      loadState.value = 'failed'
      renderedSrc.value = ''
      notifyImageSettled()
      return
    }

    renderedSrc.value = nextSrc
    loadState.value = 'ready'
  } catch (error) {
    if (runId !== resolveRunId) return
    renderedSrc.value = ''
    loadState.value = 'failed'
    notifyImageSettled()
  }
}

const handleImageLoad = () => {
  notifyImageSettled()
}

const handleImageError = () => {
  loadState.value = 'failed'
  notifyImageSettled()
}

watch(originalSrc, (src) => {
  resolveImage(src).catch(() => {
    loadState.value = 'failed'
    renderedSrc.value = ''
  })
}, { immediate: true })

onBeforeUnmount(() => {
  resolveRunId += 1
})
</script>

<template>
  <NodeViewWrapper ref="wrapperRef" class="local-image-node" contenteditable="false">
    <img
      v-if="renderedSrc"
      :src="renderedSrc"
      :alt="altText"
      :title="titleText || undefined"
      :width="width"
      :height="height"
      draggable="true"
      @load="handleImageLoad"
      @error="handleImageError"
    >
    <div v-else class="local-image-placeholder" :class="{ 'is-loading': loadState === 'loading' }">
      <span>{{ loadState === 'loading' ? '图片加载中...' : '无法加载图片' }}</span>
      <code v-if="originalSrc">{{ originalSrc }}</code>
    </div>
  </NodeViewWrapper>
</template>

<style>
.tiptap .local-image-node,
.markdown-body .local-image-node {
  margin: 0.85em 0;
}

.tiptap .local-image-node img,
.markdown-body .local-image-node img {
  max-width: 100%;
  max-height: min(70vh, 720px);
  height: auto;
  margin: 0;
  object-fit: contain;
}

.tiptap .local-image-placeholder,
.markdown-body .local-image-placeholder {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-width: 100%;
  padding: 0.75rem 0.9rem;
  border: 1px dashed var(--border-soft);
  border-radius: 6px;
  color: var(--text-muted);
  background: var(--panel-soft);
  font-size: 0.86rem;
}

.tiptap .local-image-placeholder code,
.markdown-body .local-image-placeholder code {
  color: inherit;
  background: transparent;
  padding: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}
</style>
