<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { Compass, Focus, Link2, Maximize2, Minimize2, Minus, Plus, RefreshCw, Search, X } from 'lucide-vue-next'
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import { KnowledgeGraphLoader } from '@/renderer/services/knowledge-graph-loader'
import { buildGraphEdges, layoutKnowledgeNotes, parseGraphNote, type GraphEdge, type GraphNote } from '@/shared/utils/knowledge-graph'
import { dispatchOpenNoteRef, type NoteLinkAnchor } from '@/shared/utils/note-link-ref'
import { resolveWorkspaceFilePath } from '@/shared/utils/main-content-routing'
import { KNOWLEDGE_GRAPH_WORLD, useKnowledgeGraphViewStore, type GraphNoteCard } from '@/renderer/stores/knowledge-graph-view'
import { createGraphCard, type FloatingGraphCardBounds } from '@/renderer/utils/floating-graph-card'
import KnowledgeGraphCard from './KnowledgeGraphCard.vue'
import KnowledgeGraphScene from './KnowledgeGraphScene.vue'
import { graphMotionEase, straightKnowledgeEdge, settleKnowledgeGraph, type GraphPoint } from '@/renderer/utils/knowledge-graph-physics'
import { GraphNodeIndex, graphAdjacency, graphInteractionEdges, graphLabelScale, graphNoteName, graphRectFromKey, graphRectsIntersect, graphRenderWindowKey, graphSceneLabels, type GraphCamera } from '@/renderer/utils/knowledge-graph-scene'

const workspace = useWorkspaceStore()
const loader = new KnowledgeGraphLoader()
const panel = ref<HTMLElement>()
const viewport = ref<HTMLElement>()
const expandButton = ref<HTMLButtonElement>()
const expanded = ref(false)
const diskNotes = shallowRef<GraphNote[]>([])
const draftNotes = shallowRef(new Map<string, GraphNote>())
const viewStore = useKnowledgeGraphViewStore()
const view = computed(() => viewStore.forWorkspace(workspace.activeWorkspaceId || ''))
const selectedPath = computed({ get: () => view.value.selectedPath, set: value => { view.value.selectedPath = value } })
const selectedEdgeId = ref('')
const hoveredPath = ref('')
const focused = computed({ get: () => view.value.focused, set: value => { view.value.focused = value } })
const alwaysShowReferences = computed({ get: () => view.value.alwaysShowReferences, set: value => { view.value.alwaysShowReferences = value } })
const query = computed({ get: () => view.value.query, set: value => { view.value.query = value } })
const loading = ref(false)
const loadError = ref('')
const progress = ref({ done: 0, total: 0 })
const size = ref({ width: 340, height: 420 })
const camera = computed({ get: () => view.value.camera, set: value => { view.value.camera = value } })
const cards = computed({ get: () => view.value.cards, set: value => { view.value.cards = value } })
const floatingLayer = ref<HTMLElement>()
const dragging = ref(false)
let resizeObserver: ResizeObserver | undefined
let unsubscribe: (() => void) | undefined
let reloadTimer: ReturnType<typeof setTimeout> | undefined
let draftTimer: ReturnType<typeof setTimeout> | undefined
let requestId = 0
let destroyed = false
let drag: { pointer: number; x: number; y: number; startX: number; startY: number; moved: boolean } | null = null
const draftCache = new Map<string, { content: string; note: GraphNote }>()

const notes = computed(() => diskNotes.value.map(note => draftNotes.value.has(note.path) ? { ...draftNotes.value.get(note.path)!, createdAt: note.createdAt } : note))
const graph = computed(() => buildGraphEdges(notes.value))
const noteByPath = computed(() => new Map(notes.value.map(note => [note.path, note])))
const selectedNote = computed(() => noteByPath.value.get(selectedPath.value))
const adjacency = computed(() => graphAdjacency(graph.value.edges))
const relatedEdges = computed(() => adjacency.value.get(selectedPath.value) || [])
const unreadable = computed(() => notes.value.filter(note => note.error).length)
const errorPaths = computed(() => new Set(notes.value.filter(note => note.error).map(note => note.path)))
const connected = computed(() => new Set([selectedPath.value, ...relatedEdges.value.flatMap(edge => [edge.source, edge.target])]))
const interactionEdges = computed(() => graphInteractionEdges(adjacency.value, selectedPath.value, hoveredPath.value))
const activePath = computed(() => hoveredPath.value || selectedPath.value)
const highlighted = computed(() => new Set([activePath.value, ...interactionEdges.value.flatMap(edge => [edge.source, edge.target])]))
const visibleNotes = computed(() => {
  const text = query.value.trim().toLocaleLowerCase()
  return notes.value.filter(note => (!focused.value || !selectedNote.value || connected.value.has(note.path))
    && (!text || `${note.title} ${note.path}`.toLocaleLowerCase().includes(text)))
})
// Contents and citations may change without changing any node positions.
const layoutPaths = computed(() => JSON.stringify(visibleNotes.value.map(note => [note.path, note.createdAt || 0, note.contentLength || 0])))
const packedLayout = computed(() => layoutKnowledgeNotes((JSON.parse(layoutPaths.value) as [string, number, number][]).map(([path, createdAt, contentLength]) => ({ path, createdAt, contentLength, title: graphNoteName(path), citations: [] })), KNOWLEDGE_GRAPH_WORLD.width, KNOWLEDGE_GRAPH_WORLD.height))
// Only topology invalidates relaxation; snippet edits, hover and camera changes do not.
const topologyKey = computed(() => JSON.stringify(graph.value.edges.map(edge => [edge.id, edge.source, edge.target]).sort((a, b) => a[0].localeCompare(b[0]))))
const topology = computed<GraphEdge[]>(() => (JSON.parse(topologyKey.value) as string[][]).map(([id, source, target]) => ({ id, source, target, citations: [] })))
const layout = computed(() => settleKnowledgeGraph(packedLayout.value, topology.value))
const motionFrom = shallowRef(new Map<string, GraphPoint>())
const motionProgress = ref(1)
let motionFrame: number | undefined
const motionRemaining = computed(() => 1 - graphMotionEase(motionProgress.value))
function movingPoint(path: string, point: GraphPoint): GraphPoint {
  const from = motionFrom.value.get(path)
  return from ? { x: point.x + (from.x - point.x) * motionRemaining.value, y: point.y + (from.y - point.y) * motionRemaining.value } : point
}
watch(layout, (next, previous) => {
  if (motionFrame !== undefined) cancelAnimationFrame(motionFrame)
  const previousNodes = new Map(previous?.nodes.map(node => [node.note.path, node]) || [])
  const packedNodes = new Map(packedLayout.value.nodes.map(node => [node.note.path, node]))
  const from = new Map<string, GraphPoint>()
  for (const node of next.nodes) {
    const old = previousNodes.get(node.note.path)
    from.set(node.note.path, old ? movingPoint(node.note.path, old) : packedNodes.get(node.note.path) || node)
  }
  motionFrom.value = from
  motionProgress.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0
  if (!next.nodes.length || motionProgress.value === 1) { motionProgress.value = 1; motionFrame = undefined; return }
  const start = performance.now()
  const tick = (now: number) => {
    motionProgress.value = Math.min(1, (now - start) / 560)
    if (motionProgress.value < 1) motionFrame = requestAnimationFrame(tick)
    else { motionFrame = undefined; motionFrom.value = new Map() }
  }
  motionFrame = requestAnimationFrame(tick)
}, { immediate: true })
const positioned = computed(() => new Map(layout.value.nodes.map(node => [node.note.path, node])))
const nodeIndex = computed(() => new GraphNodeIndex(layout.value.nodes))
const renderWindowKey = computed(() => graphRenderWindowKey(camera.value, size.value))
const renderWindow = computed(() => graphRectFromKey(renderWindowKey.value))
const renderedNodes = computed(() => nodeIndex.value.query(renderWindow.value))
const edgeGeometry = computed(() => topology.value.flatMap(edge => {
  const geometry = straightKnowledgeEdge(edge, positioned.value)
  return geometry ? [geometry] : []
}))
const renderedEdges = computed(() => alwaysShowReferences.value || activePath.value ? edgeGeometry.value.filter(geometry =>
  (alwaysShowReferences.value || geometry.edge.source === activePath.value || geometry.edge.target === activePath.value)
  && graphRectsIntersect(geometry.bounds, renderWindow.value)) : [])
const animatedNodes = computed(() => motionRemaining.value ? renderedNodes.value.map(node => ({ ...node, ...movingPoint(node.note.path, node) })) : renderedNodes.value)
const animatedEdges = computed(() => {
  if (!motionRemaining.value) return renderedEdges.value
  return renderedEdges.value.map(route => {
    const source = positioned.value.get(route.edge.source)!, target = positioned.value.get(route.edge.target)!
    return straightKnowledgeEdge(route.edge, new Map([
      [route.edge.source, { ...source, ...movingPoint(route.edge.source, source) }],
      [route.edge.target, { ...target, ...movingPoint(route.edge.target, target) }],
    ]))!
  })
})
const labelScale = computed(() => graphLabelScale(camera.value.scale))
const sceneLabels = computed(() => graphSceneLabels(renderedNodes.value, labelScale.value, activePath.value, highlighted.value))
const visibleCardPaths = computed(() => new Set(cards.value.filter(card => graphRectsIntersect(card, renderWindow.value)).map(card => card.path)))
const transform = computed(() => `translate(${camera.value.x}px, ${camera.value.y}px) scale(${camera.value.scale})`)
let cameraFrame: number | undefined
let pendingCamera: GraphCamera | null = null
function queueCamera(next: GraphCamera) {
  hoveredPath.value = ''
  pendingCamera = next
  if (cameraFrame !== undefined) return
  cameraFrame = requestAnimationFrame(flushCamera)
}
function flushCamera() {
  if (cameraFrame !== undefined) cancelAnimationFrame(cameraFrame)
  cameraFrame = undefined
  if (pendingCamera) camera.value = pendingCamera
  pendingCamera = null
}

function updateDrafts() {
  const overrides = new Map<string, GraphNote>()
  for (const [path, state] of Object.entries(workspace.openedTextFileContents)) {
    if (state.isPartial || state.isLoading || !/\.(md|txt)$/i.test(path)) continue
    let cached = draftCache.get(path)
    if (!cached || cached.content !== state.content) {
      cached = { content: state.content, note: parseGraphNote(path, state.content) }
      draftCache.set(path, cached)
    }
    overrides.set(path, cached.note)
  }
  for (const path of draftCache.keys()) if (!overrides.has(path)) draftCache.delete(path)
  draftNotes.value = overrides
}

async function load() {
  const ws = workspace.activeWorkspace
  const id = ++requestId
  if (!ws) { diskNotes.value = []; loading.value = false; return }
  loading.value = true
  loadError.value = ''
  try {
    const result = await loader.load({
      list: () => window.electronAPI.fs.listNotes(ws.id, { watchDirectories: true, includeCreatedAt: true }),
      read: path => window.electronAPI.file.readMarkdown(resolveWorkspaceFilePath(ws.path, path)),
    }, (done, total) => { if (id === requestId) progress.value = { done, total } })
    if (!result || id !== requestId || destroyed) return
    diskNotes.value = result
    updateDrafts()
    if (!noteByPath.value.has(selectedPath.value)) {
      selectedPath.value = ''
      focused.value = false
      selectedEdgeId.value = ''
    }
    cards.value = cards.value.filter(card => noteByPath.value.has(card.path))
    if (!view.value.initialized && layout.value.nodes.length) {
      await nextTick()
      if (id !== requestId || destroyed) return
      const node = positioned.value.get(workspace.activeFileRelativePath) || layout.value.nodes[0]
      camera.value = { scale: 1, x: size.value.width / 2 - node.x, y: size.value.height / 2 - node.y }
      view.value.initialized = true
    }
  } catch (error) {
    if (id === requestId && !destroyed) loadError.value = error instanceof Error ? error.message : '图谱加载失败'
  } finally {
    if (id === requestId && !destroyed) loading.value = false
  }
}

function scheduleLoad() {
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => { void load() }, 300)
}
function refresh() { loader.invalidate(); void load() }

function fit() {
  hoveredPath.value = ''
  flushCamera()
  const left = Math.min(0, ...cards.value.map(card => card.x))
  const top = Math.min(0, ...cards.value.map(card => card.y))
  const width = Math.max(layout.value.width, ...cards.value.map(card => card.x + card.width)) - left
  const height = Math.max(layout.value.height, ...cards.value.map(card => card.y + card.height)) - top
  const scale = Math.max(.06, Math.min(1.2, (size.value.width - 28) / width, (size.value.height - 28) / Math.max(100, height)))
  camera.value = { scale, x: (size.value.width - width * scale) / 2 - left * scale, y: (size.value.height - height * scale) / 2 - top * scale }
}
function zoom(factor: number, x = size.value.width / 2, y = size.value.height / 2, deferred = false) {
  hoveredPath.value = ''
  const previous = pendingCamera || camera.value
  const scale = Math.max(.06, Math.min(3, previous.scale * factor))
  const ratio = scale / previous.scale
  const next = { scale, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio }
  if (deferred) queueCamera(next)
  else { flushCamera(); camera.value = next }
}
function wheel(event: WheelEvent) {
  const rect = viewport.value!.getBoundingClientRect()
  zoom(Math.exp(-event.deltaY * .0015), event.clientX - rect.left, event.clientY - rect.top, true)
}
function pointerDown(event: PointerEvent) {
  if (event.button !== 0 || (event.target as Element).closest('[data-graph-control]')) return
  flushCamera()
  hoveredPath.value = ''
  drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, startX: camera.value.x, startY: camera.value.y, moved: false }
  viewport.value?.setPointerCapture(event.pointerId)
}
function pointerMove(event: PointerEvent) {
  if (!drag || drag.pointer !== event.pointerId) return
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y
  if (!drag.moved && Math.hypot(dx, dy) < 4) return
  drag.moved = true
  dragging.value = true
  queueCamera({ ...camera.value, x: drag.startX + dx, y: drag.startY + dy })
}
function pointerUp(event: PointerEvent) {
  if (drag?.pointer !== event.pointerId) return
  const clearSelection = event.type === 'pointerup' && !drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4
  flushCamera()
  if (viewport.value?.hasPointerCapture(event.pointerId)) viewport.value.releasePointerCapture(event.pointerId)
  drag = null
  dragging.value = false
  if (clearSelection) {
    selectedPath.value = ''
    selectedEdgeId.value = ''
    hoveredPath.value = ''
    focused.value = false
  }
}
function select(path: string, event?: MouseEvent | KeyboardEvent, edgeId = '') {
  selectedPath.value = path
  selectedEdgeId.value = edgeId
  const existing = cards.value.find(card => card.path === path)
  if (existing) {
    raiseCard(existing)
    if (edgeId) existing.edgeId = edgeId
    if (event?.type === 'keydown') focusCard(path)
    return
  }
  const node = positioned.value.get(path)
  const bounds = view.value.cardPlacements[path] || createGraphCard((node?.x || 0) + 30, (node?.y || 0) + 18, camera.value, size.value)
  cards.value.push({ ...bounds, path, edgeId, zIndex: nextCardZ() })
  view.value.cardPlacements[path] = { ...bounds }
  if (event?.type === 'keydown') focusCard(path)
}
function hoverNode(path: string) {
  if (!dragging.value && noteByPath.value.has(path)) hoveredPath.value = path
}
function leaveNode(path: string) {
  if (hoveredPath.value === path) hoveredPath.value = ''
}
function nextCardZ() { return Math.max(0, ...cards.value.map(card => card.zIndex)) + 1 }
function raiseCard(card: GraphNoteCard) { card.zIndex = nextCardZ() }
function focusCard(path: string) {
  nextTick(() => {
    const card = [...(floatingLayer.value?.querySelectorAll<HTMLElement>('.graph-note-card') || [])].find(element => element.dataset.cardPath === path)
    card?.querySelector<HTMLButtonElement>('.move-handle')?.focus({ preventScroll: true })
  })
}
function selectEdge(edge: GraphEdge, event?: MouseEvent | KeyboardEvent) { select(edge.source, event, edge.id) }
function closeCard(path: string) {
  cards.value = cards.value.filter(card => card.path !== path)
  nextTick(() => {
    const trigger = [...(viewport.value?.querySelectorAll<SVGElement>('[data-note-path]') || [])].find(element => element.dataset.notePath === path)
    trigger?.focus({ preventScroll: true })
  })
}
function cardBounds(path: string, bounds: FloatingGraphCardBounds) {
  const card = cards.value.find(item => item.path === path)
  if (card) {
    Object.assign(card, bounds)
    view.value.cardPlacements[path] = { ...bounds }
  }
}
function focusCurrent() {
  const path = selectedNote.value ? selectedPath.value : workspace.activeFileRelativePath
  if (!noteByPath.value.has(path)) return
  query.value = ''
  selectedPath.value = path
  selectedEdgeId.value = ''
  focused.value = true
  nextTick(fit)
}
function showAll() {
  selectedPath.value = ''
  selectedEdgeId.value = ''
  focused.value = false
  query.value = ''
  nextTick(fit)
}
function openNote(path: string, anchor?: NoteLinkAnchor) {
  if (expanded.value) setExpanded(false)
  dispatchOpenNoteRef({ relativePath: path, anchor })
}

async function setExpanded(value: boolean) {
  expanded.value = value
  await nextTick()
  if (value) panel.value?.focus()
  else expandButton.value?.focus()
  // Expanding changes the window onto the world, never the world or camera.
}
function keydown(event: KeyboardEvent) {
  if (!expanded.value) return
  if (event.key === 'Escape') { event.stopPropagation(); void setExpanded(false) }
  if (event.key === 'Tab') {
    const controls = [...panel.value!.querySelectorAll<HTMLElement>('button:not(:disabled), input, [tabindex="0"]')]
    if (!controls.length) return
    const first = controls[0], last = controls[controls.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.value)) { event.preventDefault(); first.focus() }
  }
}

watch(() => workspace.activeWorkspaceId, () => {
  hoveredPath.value = ''
  if (cameraFrame !== undefined) cancelAnimationFrame(cameraFrame)
  cameraFrame = undefined
  pendingCamera = null
  clearTimeout(reloadTimer)
  requestId++
  loader.invalidate()
  diskNotes.value = []
  draftNotes.value = new Map()
  draftCache.clear()
  selectedEdgeId.value = ''
  progress.value = { done: 0, total: 0 }
  loadError.value = ''
  if (expanded.value) void setExpanded(false)
  void load()
}, { immediate: true })
watch(renderedNodes, nodes => {
  if (hoveredPath.value && !nodes.some(node => node.note.path === hoveredPath.value)) hoveredPath.value = ''
})
watch(() => Object.entries(workspace.openedTextFileContents).map(([path, state]) => [path, state.content, state.isPartial, state.isLoading]), () => {
  clearTimeout(draftTimer)
  draftTimer = setTimeout(updateDrafts, 180)
})
watch(() => workspace.activeFileRelativePath, path => {
  if (focused.value && noteByPath.value.has(path)) { selectedPath.value = path; selectedEdgeId.value = '' }
})

onMounted(() => {
  resizeObserver = new ResizeObserver(entries => {
    const rect = entries[0].contentRect
    if (rect.width && rect.height) size.value = { width: rect.width, height: rect.height }
  })
  resizeObserver.observe(viewport.value!)
  unsubscribe = window.electronAPI.fs.onEvent(event => {
    if (event.workspaceId !== workspace.activeWorkspaceId) return
    if (!/\.(md|txt)$/i.test(event.relativePath) && event.event !== 'addDir' && event.event !== 'unlinkDir') return
    loader.invalidate(event.relativePath.replace(/\\/g, '/'))
    if (event.event === 'addDir') window.electronAPI.fs.watchAdd(event.workspaceId, [event.relativePath]).catch(() => {})
    scheduleLoad()
  })
})
onUnmounted(() => {
  if (motionFrame !== undefined) cancelAnimationFrame(motionFrame)
  destroyed = true
  requestId++
  loader.cancel()
  if (cameraFrame !== undefined) cancelAnimationFrame(cameraFrame)
  clearTimeout(reloadTimer)
  clearTimeout(draftTimer)
  unsubscribe?.()
  resizeObserver?.disconnect()
})
</script>

<template>
  <Teleport to="body" :disabled="!expanded">
    <section ref="panel" class="knowledge-panel" :class="{ 'is-expanded': expanded }" :role="expanded ? 'dialog' : 'region'" :aria-modal="expanded || undefined" aria-label="关系图谱" tabindex="-1" @keydown="keydown">
      <header class="graph-header">
        <div class="graph-heading"><Compass :size="18" /><h2>关系图谱</h2></div>
        <div class="header-actions">
          <button type="button" :disabled="loading || !workspace.activeWorkspaceId" title="重新扫描笔记" aria-label="重新扫描笔记" @click="refresh"><RefreshCw :size="15" :class="{ spinning: loading }" /></button>
          <button ref="expandButton" type="button" :title="expanded ? '收起全局视图' : '展开全局视图'" :aria-label="expanded ? '收起全局视图' : '展开全局视图'" @click="setExpanded(!expanded)"><Minimize2 v-if="expanded" :size="16" /><Maximize2 v-else :size="16" /></button>
          <button v-if="expanded" type="button" title="关闭全局视图" aria-label="关闭全局视图" @click="setExpanded(false)"><X :size="16" /></button>
        </div>
      </header>
      <div class="graph-controls">
        <div class="graph-toolbar">
          <div class="view-modes">
            <button type="button" :aria-pressed="!focused" @click="showAll">全部笔记</button>
            <button type="button" :aria-pressed="focused" :disabled="!selectedNote && !noteByPath.has(workspace.activeFileRelativePath)" @click="focusCurrent"><Focus :size="13" />聚焦笔记</button>
          </div>
          <button type="button" class="reference-toggle" aria-label="常显引用关系" :aria-pressed="alwaysShowReferences" :title="alwaysShowReferences ? '关闭引用关系常显' : '开启引用关系常显'" @click="alwaysShowReferences = !alwaysShowReferences"><Link2 :size="14" />常显引用</button>
        </div>
        <label class="graph-search"><Search :size="14" /><input v-model="query" type="search" placeholder="查找笔记" aria-label="查找笔记" @input="nextTick(fit)" /></label>
      </div>
      <div class="graph-body">
        <div class="graph-canvas-column">
          <p v-if="loadError" class="graph-warning" role="alert">{{ loadError }}<button type="button" @click="refresh">重试</button></p>
          <p v-if="unreadable" class="graph-warning">{{ unreadable }} 篇笔记读取失败，暂未解析引用。<button type="button" @click="refresh">重试</button></p>
          <div ref="viewport" class="graph-viewport" :class="{ 'is-dragging': dragging }" @pointerleave="hoveredPath = ''" @wheel.prevent="wheel" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="pointerUp" @lostpointercapture="drag = null; dragging = false">
            <svg v-if="notes.length" class="graph-map" :viewBox="`0 0 ${size.width} ${size.height}`" role="group" aria-label="笔记节点与引用图；可拖动画布、滚轮缩放，选择笔记后查看引用">
              <g class="graph-camera" :style="{ transform }">
                <KnowledgeGraphScene :nodes="animatedNodes" :edges="animatedEdges"
                  :node-labels="sceneLabels"
                  :selected-path="selectedPath" :active-path="activePath" :selected-edge-id="selectedEdgeId" :connected="highlighted" :selected-connected="connected" :error-paths="errorPaths"
                  @select="select" @hover="hoverNode" @leave="leaveNode" @edge="selectEdge" @open="openNote" />
              </g>
            </svg>
            <div ref="floatingLayer" class="graph-card-layer graph-camera" :style="{ transform }" aria-label="笔记信息悬浮卡片">
              <KnowledgeGraphCard v-for="card in cards.filter(item => noteByPath.has(item.path))" :key="card.path"
                v-show="visibleCardPaths.has(card.path)"
                v-memo="[noteByPath.get(card.path), graph, card.x, card.y, card.width, card.height, card.zIndex, card.edgeId, visibleCardPaths.has(card.path)]"
                :note="noteByPath.get(card.path)!" :notes="noteByPath" :edges="graph.edges"
                :missing="graph.missing.get(card.path) || []" :edge-id="card.edgeId" :bounds="card" :z-index="card.zIndex"
                @close="closeCard(card.path)" @activate="raiseCard(card)"
                @bounds="cardBounds(card.path, $event)" @edge="card.edgeId = $event; selectedPath = card.path; selectedEdgeId = $event"
                @open="openNote" />
            </div>
            <div v-if="!notes.length" class="graph-empty" role="status"><Compass :size="32" /><span>{{ !workspace.activeWorkspaceId ? '打开工作空间，查看笔记关系图谱' : loading ? '正在加载笔记…' : loadError ? '暂时无法加载关系图谱' : '还没有笔记，创建笔记后查看关系' }}</span></div>
            <p v-if="notes.length && !visibleNotes.length" class="graph-no-match">没有匹配的笔记</p>
            <div class="canvas-tools" data-graph-control>
              <button type="button" title="缩小" aria-label="缩小图谱" @click="zoom(1 / 1.25)"><Minus :size="15" /></button>
              <button type="button" title="适应画布" aria-label="适应画布" @click="fit">{{ Math.round(camera.scale * 100) }}%</button>
              <button type="button" title="放大" aria-label="放大图谱" @click="zoom(1.25)"><Plus :size="15" /></button>
            </div>
          </div>
          <div class="graph-status" role="status"><span>{{ loading ? `正在更新 ${progress.done}/${progress.total}` : `${notes.length} 篇笔记 · ${graph.edges.length} 条引用` }}</span><span>{{ alwaysShowReferences ? '引用关系常显' : '悬停查看连线' }} · 选中圆点查看详情</span></div>
        </div>

      </div>
    </section>
  </Teleport>

</template>

<style scoped>
.knowledge-panel{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--panel);color:var(--text-main);outline:none}
.knowledge-panel.is-expanded{position:fixed;inset:56px 24px 44px;z-index:80;height:auto;border:1px solid var(--border-soft);border-radius:16px;box-shadow:0 20px 80px color-mix(in srgb,var(--text-main) 18%,transparent);overflow:hidden}
.graph-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:16px 16px 8px;flex-shrink:0}
.graph-heading,.header-actions,.view-modes{display:flex;align-items:center;gap:6px}
.graph-heading{gap:8px;color:var(--accent)}
h2{font-size:14px;font-weight:600;color:var(--text-main)}
button{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:5px;border:0;border-radius:7px;color:var(--text-muted);background:transparent;font-size:12px;padding:7px;transition:background .15s,color .15s}
button:hover{background:var(--accent-soft);color:var(--text-main)}
button:focus-visible,input:focus-visible,[role=button]:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
button:disabled{opacity:.4;cursor:default}
button[aria-pressed=true]{background:var(--accent-soft);color:var(--accent)}
.graph-controls{padding:6px 16px 12px;display:flex;flex-direction:column;gap:10px;flex-shrink:0}
.graph-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.reference-toggle{white-space:nowrap;flex-shrink:0}
.view-modes{gap:4px;flex-wrap:wrap}
.view-modes button{padding:6px 10px}
.graph-search{display:flex;align-items:center;gap:7px;padding:7px 10px;background:var(--panel-soft);border-radius:8px;color:var(--text-muted)}
.graph-search input{width:100%;min-width:0;outline:none;background:transparent;color:var(--text-main);font-size:12px;user-select:text}
.graph-search input::placeholder{color:var(--text-subtle)}
.graph-body{display:flex;flex:1;min-height:0;flex-direction:column}
.graph-canvas-column{flex:1;min-height:150px;display:flex;flex-direction:column;overflow:hidden}
.graph-viewport{position:relative;flex:1;min-height:0;overflow:hidden;touch-action:none;cursor:grab;background-image:radial-gradient(var(--border-soft) .7px,transparent .7px);background-size:22px 22px}
.graph-viewport.is-dragging{cursor:grabbing}
.graph-map{width:100%;height:100%;display:block;user-select:none}
.graph-camera{transform-origin:0 0;will-change:transform}
.canvas-tools{position:absolute;z-index:3;bottom:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:2px;background:var(--panel);border:1px solid var(--border-soft);border-radius:9px;padding:3px;box-shadow:0 3px 12px color-mix(in srgb,var(--text-main) 5%,transparent)}
.canvas-tools button{min-width:30px;font-variant-numeric:tabular-nums}
.graph-status{padding:9px 14px;display:flex;gap:6px 12px;flex-wrap:wrap;justify-content:space-between;font-size:11px;color:var(--text-muted);border-top:1px solid var(--border-soft)}
.graph-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:30px;font-size:13px;color:var(--text-muted)}
.graph-empty>svg{color:var(--accent);opacity:.6}
.graph-no-match{position:absolute;inset:40% 0 auto;text-align:center;color:var(--text-muted);font-size:13px;pointer-events:none}
.graph-warning{font-size:12px;line-height:1.6;color:var(--text-muted);padding:8px 14px;background:var(--accent-soft);overflow-wrap:anywhere}
.graph-warning button{color:var(--accent);margin-left:5px;padding:2px 4px}
.is-expanded .graph-controls{flex-direction:row;align-items:center;justify-content:space-between}
.is-expanded .graph-search{width:240px}
.is-expanded .graph-body{flex-direction:row}
.graph-card-layer{position:absolute;left:0;top:0;width:0;height:0;z-index:2;pointer-events:none}
.spinning{animation:graph-spin 1.2s linear infinite}
@keyframes graph-spin{to{transform:rotate(360deg)}}
@keyframes node-arrive{from{opacity:0}to{opacity:1}}
@media(max-width:700px){.knowledge-panel.is-expanded{inset:44px 8px 36px}.is-expanded .graph-body{flex-direction:column}.is-expanded .graph-controls{flex-direction:column;align-items:stretch}.is-expanded .graph-search{width:auto}}
@media(prefers-reduced-motion:reduce){.knowledge-panel *{animation:none!important;transition:none!important}}
</style>
