<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useWorkspaceStore } from '../../store/workspace'

const props = defineProps<{
  filePath: string
}>()

const workspaceStore = useWorkspaceStore()
const base64Data = ref<string>('')
const isLoading = ref(true)
const loadError = ref<string | null>(null)

// Transform state
const scale = ref(1)
const translateX = ref(0)
const translateY = ref(0)
const isDragging = ref(false)
const lastMouseX = ref(0)
const lastMouseY = ref(0)

const resetTransform = () => {
  scale.value = 1
  translateX.value = 0
  translateY.value = 0
}

const onWheel = (e: WheelEvent) => {
  if (isVideo(props.filePath)) return
  
  // Use deltaY for zooming
  const delta = -Math.sign(e.deltaY)
  const zoomFactor = 0.1
  
  let newScale = scale.value * (1 + delta * zoomFactor)
  // Clamp scale between 0.1 and 10
  newScale = Math.max(0.1, Math.min(newScale, 10))
  
  scale.value = newScale
}

const onPointerDown = (e: PointerEvent) => {
  if (isVideo(props.filePath)) return
  // Only start dragging on left click
  if (e.button !== 0) return
  
  // Don't drag if clicking controls or native UI
  if ((e.target as HTMLElement)?.tagName === 'VIDEO') return

  isDragging.value = true
  lastMouseX.value = e.clientX
  lastMouseY.value = e.clientY
  
  // Capture pointer to track outside of element
  const target = e.currentTarget as HTMLElement
  if (target) {
    target.setPointerCapture(e.pointerId)
  }
}

const onPointerMove = (e: PointerEvent) => {
  if (!isDragging.value || isVideo(props.filePath)) return
  
  const deltaX = e.clientX - lastMouseX.value
  const deltaY = e.clientY - lastMouseY.value
  
  translateX.value += deltaX
  translateY.value += deltaY
  
  lastMouseX.value = e.clientX
  lastMouseY.value = e.clientY
}

const onPointerUp = (e: PointerEvent) => {
  if (!isDragging.value) return
  
  isDragging.value = false
  
  const target = e.currentTarget as HTMLElement
  if (target && target.hasPointerCapture(e.pointerId)) {
    target.releasePointerCapture(e.pointerId)
  }
}

const onDoubleClick = () => {
  if (isVideo(props.filePath)) return
  resetTransform()
}

const isVideo = (path: string) => {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return ['mp4', 'webm', 'ogg'].includes(ext)
}

const loadMedia = async () => {
  if (!props.filePath) return
  isLoading.value = true
  loadError.value = null
  resetTransform()
  
  const result = await window.electronAPI.file.readFileBase64(props.filePath)
  if (result.success && result.data) {
    base64Data.value = result.data
  } else {
    loadError.value = result.error || 'Failed to load media'
    workspaceStore.setError(loadError.value)
  }
  
  isLoading.value = false
}

onMounted(() => {
  loadMedia()
})

watch(() => props.filePath, () => {
  loadMedia()
})
</script>

<template>
  <div 
    class="relative w-full h-full flex items-center justify-center bg-zinc-100 dark:bg-zinc-950 p-8 overflow-hidden select-none"
    @wheel.prevent="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @dblclick="onDoubleClick"
    :style="{ cursor: isVideo(props.filePath) ? 'default' : (isDragging ? 'grabbing' : 'grab') }"
  >
    <div v-if="isLoading" class="flex flex-col items-center gap-3">
      <div class="w-8 h-8 border-4 border-zinc-300 dark:border-zinc-700 border-t-blue-500 rounded-full animate-spin"></div>
      <div class="text-sm text-zinc-500">正在加载...</div>
    </div>
    
    <div v-else-if="loadError" class="text-red-500 text-sm">
      {{ loadError }}
    </div>
    
    <template v-else-if="base64Data">
      <video 
        v-if="isVideo(props.filePath)" 
        controls 
        :src="base64Data" 
        class="max-w-full max-h-full rounded-lg shadow-lg object-contain pointer-events-auto"
        @pointerdown.stop
      ></video>
      <img 
        v-else 
        :src="base64Data" 
        class="max-w-full max-h-full rounded-lg shadow-lg object-contain pointer-events-none transition-transform duration-75 ease-out origin-center" 
        :style="{ transform: `translate(${translateX}px, ${translateY}px) scale(${scale})` }"
        alt="Image preview" 
      />
    </template>
  </div>
</template>
