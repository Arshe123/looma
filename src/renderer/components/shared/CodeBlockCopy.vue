<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

const props = defineProps<{ language?: string; getText: () => string | null }>()
const state = ref<'idle' | 'copied' | 'failed'>('idle')
const language = computed(() => props.language?.trim() || 'text')
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false

async function copy(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  const content = props.getText()
  if (content === null) return
  try {
    await navigator.clipboard.writeText(content)
    if (disposed) return
    state.value = 'copied'
  } catch {
    if (disposed) return
    state.value = 'failed'
  }
  clearTimeout(timer)
  timer = setTimeout(() => { state.value = 'idle' }, 1400)
}
onBeforeUnmount(() => { disposed = true; clearTimeout(timer) })
</script>

<template>
  <button
    type="button"
    class="code-block-floating-copy"
    :class="{ 'is-copied': state === 'copied', 'is-failed': state === 'failed' }"
    contenteditable="false"
    :aria-label="`复制 ${language} 代码`"
    @mousedown.prevent
    @click="copy"
  >
    <template v-if="state === 'idle'">
      <span class="code-block-copy-language">{{ language }}</span>
      <span class="code-block-copy-action">点击复制</span>
    </template>
    <span v-else class="code-block-copy-status" role="status">{{ state === 'copied' ? '已复制' : '复制失败' }}</span>
  </button>
</template>
