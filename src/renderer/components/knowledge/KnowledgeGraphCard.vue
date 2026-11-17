<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDownLeft, ArrowUpRight, Grip, GripHorizontal, X } from 'lucide-vue-next'
import type { GraphCitation, GraphEdge, GraphNote } from '@/shared/utils/knowledge-graph'
import { parseNoteLinkAnchor, parseNoteLinkHref, type NoteLinkAnchor } from '@/shared/utils/note-link-ref'
import { adjustGraphCard, type FloatingGraphCardBounds } from '@/renderer/utils/floating-graph-card'
import AiMarkdown from '@/renderer/components/ai/AiMarkdown.vue'

const props = defineProps<{
  note: GraphNote
  notes: Map<string, GraphNote>
  edges: GraphEdge[]
  missing: GraphCitation[]
  edgeId: string
  bounds: FloatingGraphCardBounds
  zIndex: number
}>()
const emit = defineEmits<{
  close: []
  activate: []
  bounds: [bounds: FloatingGraphCardBounds]
  edge: [id: string]
  open: [path: string, anchor?: NoteLinkAnchor]
}>()
const outgoing = computed(() => props.edges.filter(edge => edge.source === props.note.path))
const incoming = computed(() => props.edges.filter(edge => edge.target === props.note.path))
const selectedEdge = computed(() => props.edges.find(edge => edge.id === props.edgeId))
const contentWidth = computed(() => props.bounds.contentWidth || 320)
const contentHeight = computed(() => props.bounds.contentHeight || 400)
const frameScale = computed(() => props.bounds.width / contentWidth.value)
let operation: { kind: 'move' | 'resize'; pointer: number; x: number; y: number; scale: number; start: FloatingGraphCardBounds; target: HTMLElement } | null = null

function update(bounds: FloatingGraphCardBounds) {
  emit('bounds', bounds)
}
function handleCitationClick(event: MouseEvent, source: string) {
  if (event.type === 'auxclick' && event.button !== 1) return
  const target = event.target
  if (!(target instanceof Element)) return
  const anchor = target.closest<HTMLAnchorElement>('a[href]')
  if (!anchor) return
  event.preventDefault()
  const href = anchor.getAttribute('href') || ''
  const ref = parseNoteLinkHref(href, source)
  if (ref) emit('open', ref.relativePath, ref.anchor)
  else if (href.startsWith('#')) emit('open', source, parseNoteLinkAnchor(href.slice(1)))
  else if (/^https?:\/\//i.test(href)) void window.electronAPI.app.openExternal(href)
}
function start(event: PointerEvent, kind: 'move' | 'resize') {
  if (event.button !== 0 || (kind === 'move' && (event.target as Element).closest('button:not(.move-handle)'))) return
  event.preventDefault()
  const target = event.currentTarget as HTMLElement
  const card = target.closest('.graph-note-card')!
  const scale = card.getBoundingClientRect().width / props.bounds.width || 1
  operation = { kind, pointer: event.pointerId, x: event.clientX, y: event.clientY, scale, start: { ...props.bounds }, target }
  target.setPointerCapture(event.pointerId)
}
function move(event: PointerEvent) {
  if (!operation || event.pointerId !== operation.pointer) return
  const { start, kind, x, y, scale } = operation
  const dx = event.clientX - x, dy = event.clientY - y
  update(adjustGraphCard(start, dx, dy, scale, kind))
}
function stop(event: PointerEvent) {
  if (!operation || event.pointerId !== operation.pointer) return
  const previous = operation
  operation = null
  if (previous.target.hasPointerCapture(previous.pointer)) previous.target.releasePointerCapture(previous.pointer)
}
function keyAdjust(event: KeyboardEvent, kind: 'move' | 'resize') {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  const step = event.shiftKey ? 40 : 10
  const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0
  const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0
  update(adjustGraphCard(props.bounds, dx, dy, 1, kind))
}
</script>

<template>
  <section class="graph-note-card" data-graph-control :data-card-path="note.path" :style="{ left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px`, zIndex }" role="dialog" :aria-label="`${note.title} · 笔记信息`" @pointerdown="emit('activate')" @focusin="emit('activate')" @pointermove="move" @pointerup="stop" @pointercancel="stop" @lostpointercapture="stop" @keydown.esc.stop="emit('close')">
    <div class="card-frame" :style="{ width: `${contentWidth}px`, height: `${contentHeight}px`, transform: `scale(${frameScale})` }">
      <header class="card-titlebar" @pointerdown="start($event, 'move')">
        <button type="button" class="move-handle" aria-label="移动卡片，使用方向键调整位置" title="拖动移动卡片，或使用方向键" @keydown="keyAdjust($event, 'move')"><GripHorizontal :size="15" /></button>
        <h3>{{ note.title }}</h3>
        <button type="button" class="card-close" aria-label="关闭笔记信息卡片" title="关闭卡片" @click="emit('close')"><X :size="15" /></button>
      </header>
      <div class="card-content" @wheel.stop>
        <p class="detail-path">{{ note.path }}</p>
        <button type="button" class="open-note" @click="emit('open', note.path)">打开笔记<ArrowUpRight :size="14" /></button>
        <p v-if="note.error" class="detail-hint">{{ note.error }}</p>
        <template v-if="selectedEdge">
          <h4>引用片段 · {{ selectedEdge.citations.length }} 处</h4>
          <div v-for="(citation, index) in selectedEdge.citations" :key="index" class="citation">
              <AiMarkdown class="citation-markdown" :content="citation.snippet" :references="citation.references" @click="handleCitationClick($event, selectedEdge.source)" @auxclick="handleCitationClick($event, selectedEdge.source)" />
            <div class="citation-actions"><button type="button" @click="emit('open', selectedEdge.source, { kind: 'line', line: citation.line })">查看原文</button><button type="button" @click="emit('open', selectedEdge.target, citation.anchor)">打开被引用笔记<ArrowUpRight :size="12" /></button></div>
          </div>
        </template>
        <h4>引用了 · {{ outgoing.length }}</h4>
        <button v-for="edge in outgoing" :key="edge.id" type="button" class="relation-row" :aria-pressed="edgeId === edge.id" @click="emit('edge', edge.id)"><ArrowUpRight :size="14" /><span>{{ notes.get(edge.target)?.title }}</span><small>{{ edge.citations.length }} 处</small></button>
        <h4>被引用 · {{ incoming.length }}</h4>
        <button v-for="edge in incoming" :key="edge.id" type="button" class="relation-row" :aria-pressed="edgeId === edge.id" @click="emit('edge', edge.id)"><ArrowDownLeft :size="14" /><span>{{ notes.get(edge.source)?.title }}</span><small>{{ edge.citations.length }} 处</small></button>
        <p v-if="!outgoing.length && !incoming.length" class="detail-hint">这篇笔记还没有引用关系。添加指向其他笔记的 Markdown 链接后，会自动连线。</p>
        <template v-if="missing.length"><h4>未找到的引用 · {{ missing.length }}</h4><p v-for="(citation, index) in missing" :key="index" class="missing-ref">{{ citation.target }}</p></template>
      </div>
      <button type="button" class="resize-handle" aria-label="整体缩放卡片，使用方向键调整大小" title="拖动等比缩放整张卡片，或使用方向键" @pointerdown="start($event, 'resize')" @keydown="keyAdjust($event, 'resize')"><Grip :size="14" /></button>
    </div>
  </section>
</template>

<style scoped>
.graph-note-card{position:absolute;pointer-events:auto}
.card-frame{position:relative;display:flex;flex-direction:column;transform-origin:0 0;border:1px solid var(--border-soft);border-radius:13px;background:var(--panel);color:var(--text-main);box-shadow:0 12px 40px color-mix(in srgb,var(--text-main) 18%,transparent);overflow:hidden}
.card-titlebar{flex-shrink:0;display:flex;align-items:center;gap:6px;padding:10px 10px 10px 6px;background:var(--panel-soft);border-bottom:1px solid var(--border-soft);cursor:grab;touch-action:none;user-select:none}
.card-titlebar:active{cursor:grabbing}
.card-titlebar h3{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;border:0;border-radius:6px;color:var(--text-muted);background:transparent;font-size:12px;padding:6px}
button:hover,button[aria-pressed=true]{background:var(--accent-soft);color:var(--accent)}
button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.move-handle{cursor:grab;touch-action:none}
.card-content{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:12px 16px 24px;user-select:text}
.detail-path,.detail-hint,.missing-ref{font-size:12px;color:var(--text-muted);overflow-wrap:anywhere;line-height:1.6}
.open-note{background:var(--accent-soft);color:var(--accent);margin-top:10px;padding:6px 9px}
h4{font-size:12px;font-weight:500;margin:16px 0 6px;color:var(--text-muted)}
.relation-row{width:100%;justify-content:flex-start;text-align:left;padding:7px 6px;color:var(--text-main)}
.relation-row span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.relation-row small{color:var(--text-muted);font-size:11px}
.citation{margin:8px 0;padding:10px 0;border-bottom:1px solid var(--border-soft)}
.citation-markdown{font-size:12px;line-height:1.7;overflow-wrap:anywhere}
.citation-actions{display:flex;gap:6px;justify-content:space-between;flex-wrap:wrap;margin-top:8px}
.citation-actions button{font-size:11px;padding:4px;color:var(--accent)}
.resize-handle{position:absolute;right:2px;bottom:2px;width:24px;height:24px;padding:3px;background:var(--panel);cursor:nwse-resize;touch-action:none}
</style>
