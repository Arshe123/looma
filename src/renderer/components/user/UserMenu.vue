<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { BookOpen, RefreshCw } from 'lucide-vue-next'

const props = defineProps<{
  open: boolean
  anchor: HTMLElement | null
}>()

const menuRef = ref<HTMLElement | null>(null)
const position = ref({ left: 0, top: 0 })
const positioned = ref(false)

watch(() => [props.open, props.anchor], async () => {
  positioned.value = false
  if (!props.open || !props.anchor) return
  await nextTick()
  if (!props.open || !props.anchor || !menuRef.value) return
  const anchor = props.anchor.getBoundingClientRect()
  const menu = menuRef.value.getBoundingClientRect()
  const margin = 8
  position.value = {
    left: Math.max(margin, Math.min(anchor.right + margin, window.innerWidth - menu.width - margin)),
    top: Math.max(margin, Math.min(anchor.bottom - menu.height, window.innerHeight - menu.height - margin)),
  }
  positioned.value = true
}, { immediate: true })

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'checkUpdate'): void
  (e: 'help'): void
}>()

type MenuAction = 'checkUpdate' | 'help'

const userMenuItems: { label: string; icon: typeof RefreshCw; action: MenuAction }[] = [
  { label: '检查更新', icon: RefreshCw, action: 'checkUpdate' },
  { label: '帮助文档', icon: BookOpen, action: 'help' },
]

const close = () => {
  emit('close')
}

const handleItem = (action: MenuAction) => {
  if (action === 'checkUpdate') emit('checkUpdate')
  if (action === 'help') emit('help')
  close()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menuRef"
      class="fixed w-56 max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] rounded-xl border border-border-soft bg-panel shadow-2xl overflow-y-auto z-50"
      :style="{ left: `${position.left}px`, top: `${position.top}px`, visibility: positioned ? 'visible' : 'hidden' }"
      @pointerdown.stop
    >
      <button
        v-for="item in userMenuItems"
        :key="item.label"
        class="w-full px-3 py-2.5 text-left text-sm text-text-main hover:bg-accent-soft flex items-center gap-2"
        @click="handleItem(item.action)"
      >
        <component :is="item.icon" :size="16" class="text-text-muted shrink-0" />
        <span>{{ item.label }}</span>
      </button>
    </div>
  </Teleport>
</template>
