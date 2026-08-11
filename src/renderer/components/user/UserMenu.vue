<script setup lang="ts">
import { BookOpen, RefreshCw } from 'lucide-vue-next'

defineProps<{
  open: boolean
}>()

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
  <div
    v-if="open"
    class="absolute left-full bottom-0 ml-2 w-56 rounded-xl border border-border-soft bg-panel shadow-2xl overflow-hidden z-50"
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
</template>
