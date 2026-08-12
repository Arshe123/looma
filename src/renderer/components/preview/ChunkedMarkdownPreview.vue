<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import 'github-markdown-css/github-markdown-light.css'
import { renderMarkdownWithLineData } from '@/shared/utils/markdown-renderer'
import { splitMarkdownIntoRenderChunksWithLines } from '@/shared/utils/markdown-chunks'
import type { MarkdownOutlineItem } from '@/shared/types/MarkdownOutlineItem'
import { dispatchOpenNoteRef, parseNoteLinkHref } from '@/shared/utils/note-link-ref'
import {
  findBestTextAnchor,
  getOffsetForSourceLine,
  getScrollRatio,
  getSourceLineAtOffset,
  setScrollRatio,
} from '@/shared/utils/editor-scroll-sync'
import type { ScrollSyncState } from '@/shared/types/ScrollSyncState'

const props = defineProps<{
  content: string
  filePath: string
  relativeFilePath?: string
  isPartial: boolean
  isLoadingMore: boolean
  totalBytes: number
}>()

const emit = defineEmits<{
  (e: 'load-more'): void
  (e: 'scroll-sync', value: ScrollSyncState): void
}>()

const containerRef = ref<HTMLElement | null>(null)
const renderedChunkCache = new Map<string, string>()
const renderedChunks = computed(() => splitMarkdownIntoRenderChunksWithLines(props.content).map((chunk) => {
  const cacheKey = `${chunk.startLine}\0${chunk.content}`
  const cached = renderedChunkCache.get(cacheKey)
  if (cached !== undefined) return cached
  const html = renderMarkdownWithLineData(chunk.content, chunk.startLine)
  renderedChunkCache.set(cacheKey, html)
  return html
}))
const progress = computed(() => {
  if (!props.totalBytes) return 100
  return Math.min(100, Math.round((new Blob([props.content]).size / props.totalBytes) * 100))
})

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'])
const imageCache = new Map<string, string | null>()
let imageResolveGeneration = 0
let scrollSyncFrame: number | null = null

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

const handleNoteRefClick = (event: MouseEvent) => {
  const target = event.target as HTMLElement | null
  const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchor) return
  const href = anchor.getAttribute('href') || ''

  // 内部笔记引用：跳转到对应位置
  const ref = parseNoteLinkHref(href, props.relativeFilePath || '')
  if (ref) {
    event.preventDefault()
    dispatchOpenNoteRef(ref)
    return
  }

  // 外部 http(s) 链接：交给系统默认浏览器
  if (/^https?:/i.test(href)) {
    event.preventDefault()
    void window.electronAPI.app.openExternal(href)
  }
}

const getBlockElements = () => {
  const container = containerRef.value
  if (!container) return []
  return Array.from(container.querySelectorAll<HTMLElement>(
    'h1, h2, h3, h4, h5, h6, p, li, pre, blockquote, td, th',
  )).filter((element) => (element.textContent || '').trim())
}

const getSourceLineAnchors = () => {
  const container = containerRef.value
  if (!container) return []
  const containerRect = container.getBoundingClientRect()
  return Array.from(container.querySelectorAll<HTMLElement>('[data-line]')).map(element => ({
    line: Number(element.dataset.line),
    top: element.getBoundingClientRect().top - containerRect.top + container.scrollTop,
  }))
}

const getScrollState = (): ScrollSyncState => {
  const container = containerRef.value
  if (!container) return { ratio: 0 }
  return {
    ratio: getScrollRatio(container),
    sourceLine: getSourceLineAtOffset(getSourceLineAnchors(), container.scrollTop + 4) ?? undefined,
  }
}

const applyScrollState = (state: ScrollSyncState) => {
  const container = containerRef.value
  if (!container) return
  if (typeof state.sourceLine === 'number') {
    const offset = getOffsetForSourceLine(getSourceLineAnchors(), state.sourceLine)
    if (typeof offset === 'number') {
      container.scrollTop = offset
      return
    }
  }
  setScrollRatio(container, state.ratio)
}

const handleScroll = () => {
  requestMoreNearBoundary()
  if (scrollSyncFrame !== null) return
  scrollSyncFrame = requestAnimationFrame(() => {
    scrollSyncFrame = null
    emit('scroll-sync', getScrollState())
  })
}

const scrollToHeading = (target: MarkdownOutlineItem) => {
  const headings = Array.from(containerRef.value?.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6') || [])
  const heading = headings[target.index]
  if (!heading) return false
  heading.scrollIntoView({ block: 'start' })
  return true
}

const scrollToSourceLine = (line: number) => {
  const content = props.content || ''
  const lines = content.split('\n')
  const safeLine = Math.min(Math.max(Math.round(line || 1), 1), lines.length)
  const targetText = (lines[safeLine - 1] || '').trim()
  if (!targetText) return false
  const blocks = getBlockElements()
  const index = findBestTextAnchor(blocks.map((block) => block.textContent || ''), targetText)
  const block = index >= 0 ? blocks[index] : null
  if (!block) return false
  block.scrollIntoView({ block: 'start' })
  return true
}

watch(() => props.content, () => {
  resolveLocalImages().catch(() => {})
  requestAnimationFrame(requestMoreNearBoundary)
}, { flush: 'post' })

onMounted(() => {
  containerRef.value?.addEventListener('scroll', handleScroll, { passive: true })
  containerRef.value?.addEventListener('click', handleNoteRefClick)
  resolveLocalImages().catch(() => {})
  requestAnimationFrame(requestMoreNearBoundary)
})

onBeforeUnmount(() => {
  imageResolveGeneration += 1
  containerRef.value?.removeEventListener('scroll', handleScroll)
  containerRef.value?.removeEventListener('click', handleNoteRefClick)
  if (scrollSyncFrame !== null) cancelAnimationFrame(scrollSyncFrame)
})

defineExpose({
  scrollToHeading,
  scrollToLine: scrollToSourceLine,
  getScrollState,
  applyScrollState,
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
.chunked-markdown .looma-note-ref,
.chunked-markdown .looma-external-link {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid currentColor;
}
.chunked-markdown .looma-note-ref {
  border-bottom-style: dotted;
}
.chunked-markdown .looma-link-icon {
  display: inline-block;
  width: 0.95em;
  height: 0.95em;
  margin-right: 0.2em;
  vertical-align: -0.13em;
  color: var(--accent);
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
