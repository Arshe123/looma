<script setup lang="ts">
import { nextTick, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import {
  OPEN_NOTE_REF_EVENT,
  dispatchOpenNoteRef,
  parseNoteLinkHref,
  isHeadingAnchorMatch,
  type NoteLinkAnchor,
} from '@/shared/utils/note-link-ref'
import { parseMarkdownOutline } from '@/shared/utils/markdown-outline'
import { renderMarkdownWithLineData } from '@/shared/utils/markdown-renderer'

const props = defineProps<{
  filePath: string
  relativeFilePath: string
}>()

const workspaceStore = useWorkspaceStore()

const visible = ref(false)
const position = ref({ x: 0, y: 0 })
const title = ref('')
const snippetHtml = ref('')
const loading = ref(false)
const unresolved = ref(false)
const currentTarget = ref<{ relativePath: string; anchor?: NoteLinkAnchor } | null>(null)
const previewEl = ref<HTMLElement | null>(null)
const previewBodyRef = ref<HTMLElement | null>(null)
const previewGutterRef = ref<HTMLElement | null>(null)

const PREVIEW_CHUNK_BYTES = 256 * 1024
const SHOW_DELAY_MS = 180
const HIDE_DELAY_MS = 260
const MAX_SNIPPET_LINES = 14
const contentCache = new Map<string, string | null>()

let showTimer: number | null = null
let hideTimer: number | null = null
let fetchGeneration = 0

const getWorkspaceAbsPath = (relativePath: string) => {
  const ws = workspaceStore.activeWorkspace
  if (!ws) return ''
  const sep = ws.path.includes('\\') ? '\\' : '/'
  const root = ws.path.endsWith(sep) ? ws.path.slice(0, -1) : ws.path
  return root + sep + relativePath.split('/').join(sep)
}

const fetchTargetContent = async (relativePath: string): Promise<string | null> => {
  const cached = contentCache.get(relativePath)
  if (cached !== undefined) return cached

  const opened = workspaceStore.openedTextFileContents[relativePath]
  if (opened && !opened.isPartial && opened.content) {
    contentCache.set(relativePath, opened.content)
    return opened.content
  }

  const absPath = getWorkspaceAbsPath(relativePath)
  if (!absPath) {
    contentCache.set(relativePath, null)
    return null
  }
  const result = await window.electronAPI.file.readTextChunk(absPath, 0, PREVIEW_CHUNK_BYTES)
  const content = result.success && result.data ? result.data.content : null
  contentCache.set(relativePath, content)
  return content
}

type ExtractedSnippet = { text: string; baseLine: number }

const extractSnippet = (content: string, anchor?: NoteLinkAnchor): ExtractedSnippet | null => {
  const lines = content.split('\n')
  let from: number
  let to: number

  if (!anchor) {
    from = 0
    to = Math.min(lines.length, MAX_SNIPPET_LINES)
  } else if (anchor.kind === 'heading') {
    const outline = parseMarkdownOutline(content)
    const heading = outline.find((item) => isHeadingAnchorMatch(anchor.text, item.text))
    if (!heading) return null
    from = heading.line - 1
    const endIndex = lines.findIndex((line, index) => index > from && /^#{1,6}\s+/.test(line))
    to = endIndex === -1 ? lines.length : endIndex
    to = Math.min(to, from + MAX_SNIPPET_LINES + 2)
  } else if (anchor.kind === 'line' || anchor.kind === 'line-range') {
    const start = anchor.kind === 'line' ? anchor.line : anchor.start
    const end = anchor.kind === 'line' ? anchor.line : anchor.end
    from = Math.max(0, start - 3)
    to = Math.min(lines.length, end + 2)
  } else {
    return null
  }

  const slice = lines.slice(from, to)
  // trim 会去掉首尾空行，行号基准取第一个非空行
  const firstNonEmpty = Math.max(0, slice.findIndex((line) => line.trim().length > 0))
  const text = slice.join('\n').trim()
  if (!text) return null
  return { text, baseLine: from + firstNonEmpty }
}

const adjustPositionToViewport = async () => {
  await nextTick()
  const el = previewEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const margin = 12
  const maxX = window.innerWidth - rect.width - margin
  const maxY = window.innerHeight - rect.height - margin
  const nextX = Math.min(position.value.x, Math.max(margin, maxX))
  const nextY = Math.min(position.value.y, Math.max(margin, maxY))
  if (nextX !== position.value.x || nextY !== position.value.y) {
    position.value = { x: nextX, y: nextY }
  }
}

/** 根据 [data-line] 元素的位置在 gutter 里摆放行号。 */
const renderGutterNumbers = () => {
  const body = previewBodyRef.value
  const gutter = previewGutterRef.value
  if (!body || !gutter) return
  gutter.innerHTML = ''
  const bodyRect = body.getBoundingClientRect()
  body.querySelectorAll<HTMLElement>('[data-line]').forEach((el) => {
    const line = Number(el.dataset.line)
    if (!Number.isFinite(line)) return
    const top = el.getBoundingClientRect().top - bodyRect.top
    const span = document.createElement('span')
    span.className = 'looma-preview-gutter-line'
    span.textContent = String(line)
    span.style.top = `${Math.max(0, Math.round(top))}px`
    gutter.appendChild(span)
  })
}

const scheduleGutterRender = () => {
  void nextTick(() => {
    requestAnimationFrame(() => {
      renderGutterNumbers()
      // 图片加载后高度变化会导致行号错位，重新测量
      previewBodyRef.value?.querySelectorAll('img').forEach((img) => {
        img.addEventListener('load', renderGutterNumbers, { once: true })
      })
    })
  })
}

const applyPreview = async (relativePath: string, anchor?: NoteLinkAnchor) => {
  const generation = ++fetchGeneration
  loading.value = true
  unresolved.value = false
  snippetHtml.value = ''
  title.value = relativePath.split('/').pop() || relativePath

  const content = await fetchTargetContent(relativePath)
  if (generation !== fetchGeneration || !visible.value) return
  loading.value = false

  if (content === null) {
    unresolved.value = true
    snippetHtml.value = '<p class="looma-preview-message">无法读取该笔记内容。</p>'
    return
  }
  const extracted = extractSnippet(content, anchor)
  if (!extracted) {
    unresolved.value = true
    snippetHtml.value = `<p class="looma-preview-message">${anchor ? '未能定位到引用的位置。' : '该笔记暂无内容。'}</p>`
    return
  }
  snippetHtml.value = renderMarkdownWithLineData(extracted.text, extracted.baseLine)
  scheduleGutterRender()
  await adjustPositionToViewport()
}

const onMouseOver = (event: MouseEvent) => {
  if (document.querySelector('[data-looma-editor-context-menu]')) return
  const target = event.target as HTMLElement | null
  const anchorEl = target?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchorEl) return
  // 浮窗自身渲染出的链接不触发嵌套预览
  if (anchorEl.closest('.looma-note-preview')) return
  const ref = parseNoteLinkHref(anchorEl.getAttribute('href') || '', props.relativeFilePath)
  if (!ref) return
  if (showTimer) window.clearTimeout(showTimer)
  if (hideTimer) window.clearTimeout(hideTimer)

  currentTarget.value = ref
  showTimer = window.setTimeout(() => {
    visible.value = true
    position.value = { x: event.clientX + 14, y: event.clientY + 14 }
    void applyPreview(ref.relativePath, ref.anchor)
    void adjustPositionToViewport()
  }, SHOW_DELAY_MS)
}

const onMouseOut = (event: MouseEvent) => {
  const target = event.target as HTMLElement | null
  const anchorEl = target?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchorEl) return
  const ref = parseNoteLinkHref(anchorEl.getAttribute('href') || '', props.relativeFilePath)
  if (!ref) return
  if (showTimer) window.clearTimeout(showTimer)
  hideTimer = window.setTimeout(() => {
    visible.value = false
    fetchGeneration += 1
  }, HIDE_DELAY_MS)
}

/** 立即关闭浮窗并清空所有挂起的定时器。 */
const closePreview = () => {
  if (showTimer) window.clearTimeout(showTimer)
  if (hideTimer) window.clearTimeout(hideTimer)
  showTimer = null
  hideTimer = null
  visible.value = false
  fetchGeneration += 1
}

const onContextMenu = (event: MouseEvent) => {
  const target = event.target as HTMLElement | null
  const anchorEl = target?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchorEl || anchorEl.closest('.looma-note-preview')) return
  if (!parseNoteLinkHref(anchorEl.getAttribute('href') || '', props.relativeFilePath)) return
  closePreview()
}

const cancelHide = () => {
  if (hideTimer) window.clearTimeout(hideTimer)
}

const scheduleHide = () => {
  hideTimer = window.setTimeout(() => {
    visible.value = false
    fetchGeneration += 1
  }, HIDE_DELAY_MS)
}

const jumpToTarget = () => {
  const target = currentTarget.value
  if (!target) return
  closePreview()
  dispatchOpenNoteRef(target)
}

/** 浮窗内容中渲染出的链接：内部笔记跳转，外部链接交给系统默认浏览器。 */
const handlePreviewContentClick = (event: MouseEvent) => {
  const target = event.target as HTMLElement | null
  const anchorEl = target?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchorEl) return
  const href = anchorEl.getAttribute('href') || ''

  const ref = parseNoteLinkHref(href, props.relativeFilePath)
  if (ref) {
    event.preventDefault()
    closePreview()
    dispatchOpenNoteRef(ref)
    return
  }
  if (/^https?:/i.test(href)) {
    event.preventDefault()
    closePreview()
    void window.electronAPI.app.openExternal(href)
  }
}

const handleOpenNoteRefEvent = () => {
  // 任何笔记引用跳转发生时（包括本组件自己触发的），立即关闭浮窗
  closePreview()
}

onMounted(() => {
  document.addEventListener('mouseover', onMouseOver)
  document.addEventListener('mouseout', onMouseOut)
  document.addEventListener('contextmenu', onContextMenu)
  window.addEventListener(OPEN_NOTE_REF_EVENT, handleOpenNoteRefEvent)
})

onDeactivated(() => {
  // KeepAlive 切走（打开其他笔记）时，确保浮窗不残留
  closePreview()
})

onBeforeUnmount(() => {
  if (showTimer) window.clearTimeout(showTimer)
  if (hideTimer) window.clearTimeout(hideTimer)
  document.removeEventListener('mouseover', onMouseOver)
  document.removeEventListener('mouseout', onMouseOut)
  document.removeEventListener('contextmenu', onContextMenu)
  window.removeEventListener(OPEN_NOTE_REF_EVENT, handleOpenNoteRefEvent)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="previewEl"
      class="looma-note-preview fixed z-[9999] w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-border-soft bg-panel shadow-2xl overflow-hidden"
      :style="{ left: `${position.x}px`, top: `${position.y}px` }"
      @mouseenter="cancelHide"
      @mouseleave="scheduleHide"
      @click="handlePreviewContentClick"
    >
      <div class="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-text-main border-b border-border-soft bg-panel-soft/60">
        <span class="truncate">{{ title }}</span>
        <span class="ml-auto shrink-0 text-text-muted font-normal">笔记引用</span>
      </div>
      <div class="max-h-60 overflow-y-auto focus-scrollbar">
        <div v-if="loading" class="px-3 py-3 text-sm text-text-muted">加载中...</div>
        <div
          v-else-if="unresolved"
          class="looma-preview-body markdown-body px-3 py-2.5 text-[13px] leading-relaxed looma-preview-unresolved"
          v-html="snippetHtml"
        />
        <div v-else class="relative looma-preview-wrap">
          <div ref="previewGutterRef" class="looma-preview-gutter" aria-hidden="true" />
          <div
            ref="previewBodyRef"
            class="looma-preview-body markdown-body pl-12 pr-3 py-2.5 text-[13px] leading-relaxed"
            v-html="snippetHtml"
          />
        </div>
      </div>
      <button
        class="w-full px-3 py-2 text-xs text-accent border-t border-border-soft hover:bg-accent-soft transition-colors"
        @click="jumpToTarget"
      >
        跳转到该位置
      </button>
    </div>
  </Teleport>
</template>

<style>
.looma-note-preview {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}

/* ---- 引用预览行号 gutter ---- */
.looma-preview-wrap {
  position: relative;
}

.looma-preview-gutter {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 2.75rem;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
}

.looma-preview-gutter-line {
  position: absolute;
  left: 0.25rem;
  right: 0.4rem;
  text-align: right;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 10.5px;
  /* 与正文 13px * 1.6 行高一致，保证行号与文本行垂直对齐 */
  line-height: 20.8px;
  color: var(--text-subtle);
  white-space: nowrap;
}

.looma-preview-body.markdown-body {
  color: var(--text-main);
  background: transparent;
  font-size: 13px;
  line-height: 1.6;
}

.looma-preview-body.markdown-body h1,
.looma-preview-body.markdown-body h2,
.looma-preview-body.markdown-body h3,
.looma-preview-body.markdown-body h4,
.looma-preview-body.markdown-body h5,
.looma-preview-body.markdown-body h6 {
  margin: 0.4em 0 0.3em;
  padding: 0;
  border: none;
  font-weight: 600;
  line-height: 1.4;
}

.looma-preview-body.markdown-body h1 { font-size: 1.15em; }
.looma-preview-body.markdown-body h2 { font-size: 1.1em; }
.looma-preview-body.markdown-body h3 { font-size: 1.05em; }
.looma-preview-body.markdown-body h4,
.looma-preview-body.markdown-body h5,
.looma-preview-body.markdown-body h6 { font-size: 1em; }

.looma-preview-body.markdown-body p,
.looma-preview-body.markdown-body ul,
.looma-preview-body.markdown-body ol,
.looma-preview-body.markdown-body blockquote,
.looma-preview-body.markdown-body pre,
.looma-preview-body.markdown-body table {
  margin: 0.35em 0;
}

.looma-preview-body.markdown-body pre {
  padding: 0.5rem 0.65rem;
  font-size: 12px;
  background: var(--panel-soft);
  border: 1px solid var(--border-soft);
  border-radius: 6px;
}

.looma-preview-body.markdown-body code {
  background: var(--panel-soft);
  border-radius: 4px;
  font-size: 0.92em;
}

.looma-preview-body.markdown-body img {
  max-height: 120px;
  max-width: 100%;
  object-fit: contain;
}

.looma-preview-body.markdown-body a {
  color: var(--accent);
}

.looma-preview-message {
  color: var(--text-muted);
  font-style: italic;
}

.looma-preview-unresolved {
  color: var(--text-muted);
  font-style: italic;
}
</style>
