<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { CodeXml } from 'lucide-vue-next'
import {
  computeResizedImageWidthPercent,
  formatMarkdownImage,
  type ImageResizeDirection,
  parseMarkdownImageBlock,
} from '@/shared/utils/tiptap-image-insertion'

const props = defineProps(nodeViewProps)

type ImageLoadState = 'idle' | 'loading' | 'ready' | 'failed'
const PREVIEW_IMAGE_SETTLED_EVENT = 'looma:preview-image-settled'

const renderedSrc = ref('')
const loadState = ref<ImageLoadState>('idle')
const wrapperRef = ref<any | null>(null)
const imageRef = ref<HTMLImageElement | null>(null)
const markdownInputRef = ref<HTMLInputElement | null>(null)
const editingMarkdown = ref(false)
const markdownDraft = ref('')
const markdownError = ref('')
const resizing = ref(false)
const previewWidthPercent = ref<number | null>(null)
let resolveRunId = 0
let resizeStart: {
  direction: ImageResizeDirection
  clientX: number
  clientY: number
  width: number
  height: number
  containerWidth: number
} | null = null

const originalSrc = computed(() => (
  typeof props.node.attrs.src === 'string' ? props.node.attrs.src : ''
))

const altText = computed(() => (
  typeof props.node.attrs.alt === 'string' ? props.node.attrs.alt : ''
))

const titleText = computed(() => (
  typeof props.node.attrs.title === 'string' ? props.node.attrs.title : ''
))

const persistedWidthPercent = computed<number | null>(() => {
  const value = props.node.attrs.widthPercent
  return typeof value === 'number' && value >= 10 && value <= 100 ? value : null
})
const imageFrameStyle = computed(() => {
  const widthPercent = previewWidthPercent.value ?? persistedWidthPercent.value
  return widthPercent === null ? undefined : { width: `${widthPercent}%` }
})
const currentMarkdown = computed(() => formatMarkdownImage({
  alt: altText.value,
  src: originalSrc.value,
  title: titleText.value || undefined,
  widthPercent: persistedWidthPercent.value ?? undefined,
}))
const imageLineNumberDecoration = computed(() => (
  (props.decorations as any[]).find(decoration => decoration.spec?.imageLineNumber === true)
))
const imageLineNumber = computed<number | null>(() => {
  const line = imageLineNumberDecoration.value?.spec?.lineNumber
  return typeof line === 'number' ? line : null
})
const imageLineNumberActive = computed(() => imageLineNumberDecoration.value?.spec?.activeLine === true)

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

const cancelMarkdownEdit = () => {
  editingMarkdown.value = false
  markdownError.value = ''
  markdownDraft.value = currentMarkdown.value
}

const startMarkdownEdit = () => {
  markdownDraft.value = currentMarkdown.value
  markdownError.value = ''
  editingMarkdown.value = true
  nextTick(() => {
    const input = markdownInputRef.value
    if (!input) return
    input.focus()
    const pathStart = markdownDraft.value.indexOf('](') + 2
    const pathEnd = markdownDraft.value.lastIndexOf(')')
    if (pathStart >= 2 && pathEnd >= pathStart) input.setSelectionRange(pathStart, pathEnd)
    else input.select()
  })
}

const selectImage = () => {
  const position = props.getPos()
  if (typeof position !== 'number') return
  props.editor.chain().focus().setNodeSelection(position).run()
}

const handleImageClick = () => {
  selectImage()
}

const handleImageDoubleClick = () => {
  selectImage()
  startMarkdownEdit()
}

const stopResizeListeners = () => {
  window.removeEventListener('pointermove', handleResizeMove)
  window.removeEventListener('pointerup', handleResizeEnd)
  window.removeEventListener('pointercancel', handleResizeEnd)
}

const handleResizeMove = (event: PointerEvent) => {
  if (!resizeStart) return
  event.preventDefault()
  previewWidthPercent.value = computeResizedImageWidthPercent({
    direction: resizeStart.direction,
    startWidth: resizeStart.width,
    startHeight: resizeStart.height,
    containerWidth: resizeStart.containerWidth,
    deltaX: event.clientX - resizeStart.clientX,
    deltaY: event.clientY - resizeStart.clientY,
  })
}

const handleResizeEnd = () => {
  if (!resizeStart) return
  resizeStart = null
  resizing.value = false
  stopResizeListeners()
  if (previewWidthPercent.value !== null) {
    props.updateAttributes({ widthPercent: previewWidthPercent.value })
  }
}

const startResize = (direction: ImageResizeDirection, event: PointerEvent) => {
  const image = imageRef.value
  const wrapper = getWrapperElement()
  if (!image || !wrapper) return
  event.preventDefault()
  event.stopPropagation()
  selectImage()
  const imageRect = image.getBoundingClientRect()
  const containerWidth = wrapper.parentElement?.clientWidth || wrapper.clientWidth
  if (imageRect.width <= 0 || imageRect.height <= 0 || containerWidth <= 0) return
  resizeStart = {
    direction,
    clientX: event.clientX,
    clientY: event.clientY,
    width: imageRect.width,
    height: imageRect.height,
    containerWidth,
  }
  previewWidthPercent.value = persistedWidthPercent.value
    ?? Math.round((imageRect.width / containerWidth) * 100)
  resizing.value = true
  window.addEventListener('pointermove', handleResizeMove, { passive: false })
  window.addEventListener('pointerup', handleResizeEnd)
  window.addEventListener('pointercancel', handleResizeEnd)
}

const saveMarkdownEdit = () => {
  const target = parseMarkdownImageBlock(markdownDraft.value.trim())
  if (!target) {
    markdownError.value = '请输入完整的 Markdown 图片格式，例如 ![说明](assets/image.png)'
    return
  }

  props.updateAttributes({
    alt: target.alt,
    src: target.src,
    title: target.title ?? null,
    widthPercent: target.widthPercent ?? null,
  })
  editingMarkdown.value = false
  markdownError.value = ''
}

const handleDocumentPointerDown = (event: PointerEvent) => {
  if (!editingMarkdown.value) return
  const wrapper = getWrapperElement()
  if (wrapper?.contains(event.target as Node)) return
  cancelMarkdownEdit()
}

watch(originalSrc, (src) => {
  resolveImage(src).catch(() => {
    loadState.value = 'failed'
    renderedSrc.value = ''
  })
}, { immediate: true })

watch(currentMarkdown, (markdown) => {
  if (!editingMarkdown.value) markdownDraft.value = markdown
}, { immediate: true })

onMounted(() => document.addEventListener('pointerdown', handleDocumentPointerDown, true))

onBeforeUnmount(() => {
  resolveRunId += 1
  resizeStart = null
  stopResizeListeners()
  document.removeEventListener('pointerdown', handleDocumentPointerDown, true)
})
</script>

<template>
  <NodeViewWrapper
    ref="wrapperRef"
    class="local-image-node"
    :class="{ 'is-markdown-editing': editingMarkdown, 'is-resizing': resizing }"
    contenteditable="false"
  >
    <span
      v-if="imageLineNumber !== null"
      class="looma-line-number looma-image-line-number"
      :class="{ 'looma-line-number-active': imageLineNumberActive }"
      :data-line="imageLineNumber"
      aria-hidden="true"
    >{{ imageLineNumber }}</span>
    <div v-if="renderedSrc" class="local-image-resize-frame" :style="imageFrameStyle">
      <img
        ref="imageRef"
        :src="renderedSrc"
        :alt="altText"
        :title="titleText || '单击选择，双击编辑图片 Markdown'"
        draggable="true"
        @load="handleImageLoad"
        @error="handleImageError"
        @click.stop="handleImageClick"
        @dblclick.stop="handleImageDoubleClick"
      >
      <template v-if="props.selected && !editingMarkdown">
        <button
          type="button"
          class="local-image-resize-handle local-image-resize-right"
          aria-label="从右侧等比例缩放图片"
          tabindex="-1"
          @pointerdown="startResize('right', $event)"
        />
        <button
          type="button"
          class="local-image-resize-handle local-image-resize-bottom"
          aria-label="从下侧等比例缩放图片"
          tabindex="-1"
          @pointerdown="startResize('bottom', $event)"
        />
        <button
          type="button"
          class="local-image-resize-handle local-image-resize-bottom-right"
          aria-label="从右下角等比例缩放图片"
          tabindex="-1"
          @pointerdown="startResize('bottomRight', $event)"
        />
      </template>
    </div>
    <div
      v-else
      class="local-image-placeholder"
      :class="{ 'is-loading': loadState === 'loading' }"
      @click.stop="startMarkdownEdit"
    >
      <span>{{ loadState === 'loading' ? '图片加载中...' : '无法加载图片' }}</span>
      <code v-if="originalSrc">{{ originalSrc }}</code>
    </div>

    <div v-if="editingMarkdown" class="local-image-markdown-editor" @click.stop>
      <CodeXml :size="14" class="local-image-markdown-icon" />
      <input
        ref="markdownInputRef"
        v-model="markdownDraft"
        class="local-image-markdown-input"
        type="text"
        aria-label="图片 Markdown"
        spellcheck="false"
        autocomplete="off"
        @keydown.enter.prevent="saveMarkdownEdit"
        @keydown.esc.prevent="cancelMarkdownEdit"
      >
      <span class="local-image-markdown-hint">Enter 保存 · Esc 取消</span>
    </div>
    <div v-if="editingMarkdown && markdownError" class="local-image-markdown-error">
      {{ markdownError }}
    </div>
  </NodeViewWrapper>
</template>

<style>
.tiptap .local-image-node,
.markdown-body .local-image-node {
  position: relative;
  margin: 0.85em 0;
  border-radius: 8px;
}

.tiptap .local-image-resize-frame,
.markdown-body .local-image-resize-frame {
  position: relative;
  width: fit-content;
  max-width: 100%;
}

.tiptap .local-image-resize-frame[style] img,
.markdown-body .local-image-resize-frame[style] img {
  width: 100%;
  max-height: none;
}

.tiptap .local-image-node.ProseMirror-selectednode img,
.tiptap .local-image-node.is-resizing img {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.tiptap .local-image-resize-handle {
  position: absolute;
  z-index: 2;
  width: 10px;
  height: 10px;
  padding: 0;
  border: 2px solid var(--panel-bg);
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
  touch-action: none;
}

.tiptap .local-image-resize-right {
  top: 50%;
  right: -5px;
  transform: translateY(-50%);
  cursor: ew-resize;
}

.tiptap .local-image-resize-bottom {
  bottom: -5px;
  left: 50%;
  transform: translateX(-50%);
  cursor: ns-resize;
}

.tiptap .local-image-resize-bottom-right {
  right: -5px;
  bottom: -5px;
  cursor: nwse-resize;
}

.tiptap .local-image-node > .looma-image-line-number {
  top: 0;
  left: -2.5rem;
}

.tiptap .local-image-node.is-markdown-editing img,
.tiptap .local-image-node.is-markdown-editing .local-image-placeholder,
.markdown-body .local-image-node.is-markdown-editing img,
.markdown-body .local-image-node.is-markdown-editing .local-image-placeholder {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.tiptap .local-image-node img,
.markdown-body .local-image-node img {
  max-width: 100%;
  max-height: min(70vh, 720px);
  height: auto;
  margin: 0;
  object-fit: contain;
  cursor: pointer;
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
  cursor: pointer;
}

.tiptap .local-image-placeholder code,
.markdown-body .local-image-placeholder code {
  color: inherit;
  background: transparent;
  padding: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}

.tiptap .local-image-markdown-editor,
.markdown-body .local-image-markdown-editor {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--border-soft);
  border-radius: 7px;
  background: var(--panel-soft);
  box-shadow: 0 6px 18px rgb(15 23 42 / 0.08);
  cursor: default;
}

.tiptap .local-image-markdown-icon,
.markdown-body .local-image-markdown-icon {
  flex: 0 0 auto;
  color: var(--accent);
}

.tiptap .local-image-markdown-input,
.markdown-body .local-image-markdown-input {
  min-width: 0;
  flex: 1 1 auto;
  padding: 0;
  border: 0;
  outline: 0;
  color: var(--text-main);
  background: transparent;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.78rem;
  cursor: text;
}

.tiptap .local-image-markdown-hint,
.markdown-body .local-image-markdown-hint {
  flex: 0 0 auto;
  color: var(--text-subtle);
  font-size: 0.68rem;
  white-space: nowrap;
}

.tiptap .local-image-markdown-error,
.markdown-body .local-image-markdown-error {
  margin-top: 0.35rem;
  color: var(--danger);
  font-size: 0.72rem;
}

@media (max-width: 640px) {
  .tiptap .local-image-markdown-editor,
  .markdown-body .local-image-markdown-editor {
    align-items: stretch;
    flex-wrap: wrap;
  }

  .tiptap .local-image-markdown-input,
  .markdown-body .local-image-markdown-input {
    width: calc(100% - 1.5rem);
  }

  .tiptap .local-image-markdown-hint,
  .markdown-body .local-image-markdown-hint {
    width: 100%;
    padding-left: 1.4rem;
  }
}
</style>
