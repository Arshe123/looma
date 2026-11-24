<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Minus, Plus, X } from 'lucide-vue-next'

const props = defineProps<{ src: string; width: number; height: number }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
const canvas = ref<HTMLElement>()
const camera = ref({ x: 0, y: 0, scale: 1 })
const dragging = ref(false)
const transform = computed(() => `translate(${camera.value.x}px, ${camera.value.y}px) scale(${camera.value.scale})`)
let observer: ResizeObserver | undefined
let fitted = true
let drag: { id: number; clientX: number; clientY: number; x: number; y: number } | undefined

function fit() {
  if (!canvas.value) return
  const { clientWidth: width, clientHeight: height } = canvas.value
  if (!width || !height) return
  const scale = Math.max(.001, Math.min(4, (width - 48) / props.width, (height - 96) / props.height))
  camera.value = { scale, x: (width - props.width * scale) / 2, y: (height - props.height * scale) / 2 }
  fitted = true
}

function zoom(factor: number, event?: WheelEvent) {
  if (!canvas.value) return
  const bounds = canvas.value.getBoundingClientRect()
  const x = event ? event.clientX - bounds.left : bounds.width / 2
  const y = event ? event.clientY - bounds.top : bounds.height / 2
  const previous = camera.value
  const scale = Math.max(.001, Math.min(16, previous.scale * factor))
  const ratio = scale / previous.scale
  camera.value = { scale, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio }
  fitted = false
}

function startPan(event: PointerEvent) {
  if (event.button !== 0 || drag || !canvas.value) return
  canvas.value.setPointerCapture(event.pointerId)
  drag = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, ...camera.value }
  dragging.value = true
}

function pan(event: PointerEvent) {
  if (drag?.id !== event.pointerId) return
  camera.value = { ...camera.value, x: drag.x + event.clientX - drag.clientX, y: drag.y + event.clientY - drag.clientY }
  fitted = false
}

function endPan(event: PointerEvent) {
  if (drag?.id !== event.pointerId) return
  drag = undefined
  dragging.value = false
}

onMounted(() => {
  dialog.value?.showModal()
  fit()
  observer = new ResizeObserver(() => { if (fitted) fit() })
  if (canvas.value) observer.observe(canvas.value)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  if (dialog.value?.open) dialog.value.close()
})
</script>

<template>
  <dialog ref="dialog" class="mermaid-viewer" aria-label="Mermaid 图表" @close="emit('close')">
    <header class="viewer-header">
      <h2>Mermaid 图表</h2>
      <button type="button" title="关闭图表" aria-label="关闭图表" autofocus @click="dialog?.close()"><X :size="18" /></button>
    </header>
    <div class="viewer-body">
      <div ref="canvas" class="mermaid-viewer-canvas" :class="{ 'is-dragging': dragging }"
        @wheel.prevent.stop="zoom(Math.exp(-$event.deltaY * .0015), $event)" @dblclick="fit"
        @pointerdown="startPan" @pointermove="pan" @pointerup="endPan" @pointercancel="endPan" @lostpointercapture="endPan">
        <img :src="src" :width="width" :height="height" :style="{ transform }" draggable="false" alt="Mermaid 图表" />
      </div>
      <div class="viewer-tools" role="group" aria-label="图表缩放">
        <button type="button" title="缩小图表" aria-label="缩小图表" @click="zoom(1 / 1.25)"><Minus :size="15" /></button>
        <button type="button" title="适应画布" aria-label="适应画布" @click="fit">{{ Math.round(camera.scale * 100) }}%</button>
        <button type="button" title="放大图表" aria-label="放大图表" @click="zoom(1.25)"><Plus :size="15" /></button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.mermaid-viewer {
  position: fixed;
  inset: 56px 24px 44px;
  width: auto;
  height: auto;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border-soft);
  border-radius: 16px;
  background: var(--panel);
  color: var(--text-main);
  box-shadow: 0 20px 80px color-mix(in srgb, var(--text-main) 18%, transparent);
  font-family: var(--font-ui);
}
.mermaid-viewer[open] { display: flex; flex-direction: column; }
.mermaid-viewer::backdrop { background: rgb(0 0 0 / 24%); }
.viewer-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; border-bottom: 1px solid var(--border-soft); }
h2 { margin: 0; font-size: 14px; font-weight: 600; }
.viewer-body { position: relative; flex: 1; min-height: 0; }
.mermaid-viewer-canvas {
  position: absolute;
  inset: 0;
  overflow: hidden;
  touch-action: none;
  cursor: grab;
  background-image: radial-gradient(var(--border-soft) .7px, transparent .7px);
  background-size: 22px 22px;
}
.mermaid-viewer-canvas.is-dragging { cursor: grabbing; }
.mermaid-viewer-canvas img { position: absolute; top: 0; left: 0; max-width: none; transform-origin: 0 0; background: #fff; pointer-events: none; user-select: none; }
.viewer-tools {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border-soft);
  border-radius: 9px;
  background: var(--panel);
}
button { display: inline-flex; align-items: center; justify-content: center; min-width: 30px; padding: 7px; border-radius: 7px; cursor: pointer; color: var(--text-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
button:hover { background: var(--accent-soft); color: var(--text-main); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
@media (max-width: 700px), (max-height: 480px) { .mermaid-viewer { inset: 12px 8px; } }
</style>
