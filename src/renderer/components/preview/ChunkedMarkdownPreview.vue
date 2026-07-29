<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import 'github-markdown-css/github-markdown-light.css'
import { renderMarkdown } from '@/shared/utils/markdown-renderer'
import { splitMarkdownIntoRenderChunks } from '@/shared/utils/markdown-chunks'

const props = defineProps<{
  content: string
  filePath: string
  isPartial: boolean
  isLoadingMore: boolean
  totalBytes: number
}>()

const emit = defineEmits<{
  (e: 'load-more'): void
}>()

const containerRef = ref<HTMLElement | null>(null)
const renderedChunkCache = new Map<string, string>()
const renderedChunks = computed(() => splitMarkdownIntoRenderChunks(props.content).map((chunk) => {
  const cached = renderedChunkCache.get(chunk)
  if (cached !== undefined) return cached
  const html = renderMarkdown(chunk)
  renderedChunkCache.set(chunk, html)
  return html
}))
const progress = computed(() => {
  if (!props.totalBytes) return 100
  return Math.min(100, Math.round((new Blob([props.content]).size / props.totalBytes) * 100))
})

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const imageCache = new Map<string, string | null>()
let imageResolveGeneration = 0

const pathSeparator = (path: string) => path.includes('\\') ? '\\' : '/'
const fileDirectory = (path: string) => {
  const separator = pathSeparator(path)
  const index = path.lastIndexOf(separator)
  return index >= 0 ? path.slice(0, index) : ''
}
const normalizePath = (path: string, separator: string) => {
  const drive = path.match(/^[a-zA-Z]:[\\/]/)?.[0] || ''
  const rooted = !drive && /^[\\/]/.test(path)
  const parts: string[] = []
  for (const part of path.replace(/^[a-zA-Z]:[\\/]/, '').split(/[\\/]+/)) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${drive ? drive.slice(0, 2) + separator : rooted ? separator : ''}${parts.join(separator)}`
}
const resolveImagePath = (source: string) => {
  if (/^(https?:|data:|blob:)/i.test(source)) return ''
  let decoded = source
  try { decoded = decodeURIComponent(source) } catch {}
  const clean = decoded.split(/[?#]/, 1)[0]
  const extension = clean.split('.').pop()?.toLowerCase() || ''
  if (!IMAGE_EXTENSIONS.has(extension)) return ''
  if (/^[a-zA-Z]:[\\/]/.test(clean) || /^\\\\/.test(clean)) {
    return normalizePath(clean, pathSeparator(clean))
  }
  const directory = fileDirectory(props.filePath)
  const separator = pathSeparator(props.filePath)
  return directory ? normalizePath(`${directory}${separator}${clean}`, separator) : ''
}

const resolveLocalImages = async () => {
  const generation = ++imageResolveGeneration
  await nextTick()
  const images = Array.from(containerRef.value?.querySelectorAll<HTMLImageElement>('img[src]') || [])
  await Promise.all(images.map(async (image) => {
    const filePath = resolveImagePath(image.getAttribute('src') || '')
    if (!filePath) return
    let data = imageCache.get(filePath)
    if (data === undefined) {
      const result = await window.electronAPI.file.readFileBase64(filePath)
      data = result.success && result.data ? result.data : null
      imageCache.set(filePath, data)
    }
    if (generation === imageResolveGeneration && data && image.isConnected) image.src = data
  }))
}

const requestMoreNearBoundary = () => {
  const container = containerRef.value
  if (!container || !props.isPartial || props.isLoadingMore) return
  if (container.scrollHeight - container.scrollTop - container.clientHeight < 1200) emit('load-more')
}

watch(() => props.content, () => {
  resolveLocalImages().catch(() => {})
  requestAnimationFrame(requestMoreNearBoundary)
}, { flush: 'post' })

onMounted(() => {
  containerRef.value?.addEventListener('scroll', requestMoreNearBoundary, { passive: true })
  resolveLocalImages().catch(() => {})
  requestAnimationFrame(requestMoreNearBoundary)
})

onBeforeUnmount(() => {
  imageResolveGeneration += 1
  containerRef.value?.removeEventListener('scroll', requestMoreNearBoundary)
})
</script>

<template>
  <div ref="containerRef" class="h-full w-full overflow-y-auto bg-panel focus-scrollbar">
    <div class="markdown-body chunked-markdown mx-auto max-w-none p-8">
      <section
        v-for="(html, index) in renderedChunks"
        :key="index"
        class="markdown-render-chunk"
        v-html="html"
      />
      <div v-if="isPartial || isLoadingMore" class="chunk-load-state" aria-live="polite">
        <span class="chunk-load-spinner" />
        <span>已加载 {{ progress }}%，继续向下滚动将加载更多内容</span>
      </div>
    </div>
  </div>
</template>

<style>
.chunked-markdown {
  min-height: 100%;
  color: var(--text-main);
  background: transparent !important;
  padding-bottom: calc(2rem + 22vh) !important;
}
.markdown-render-chunk {
  content-visibility: auto;
  contain-intrinsic-size: auto 720px;
}
.chunk-load-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.55rem;
  min-height: 4rem;
  color: var(--text-muted);
  font-size: 0.8rem;
}
.chunk-load-spinner {
  width: 0.9rem;
  height: 0.9rem;
  border: 2px solid var(--border-soft);
  border-top-color: var(--accent);
  border-radius: 999px;
  animation: chunk-spin 0.8s linear infinite;
}
@keyframes chunk-spin { to { transform: rotate(360deg); } }
</style>
