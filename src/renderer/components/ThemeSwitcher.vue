<script setup lang="ts">
import { Monitor, Moon, Sun } from 'lucide-vue-next'
import { useWorkspaceStore, type ThemeName } from '@/renderer/stores/workspace'

const workspaceStore = useWorkspaceStore()
const themes: { id: ThemeName; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: '日间模式', icon: Sun },
  { id: 'dark', label: '夜间模式', icon: Moon },
  { id: 'system', label: '跟随系统', icon: Monitor },
]
</script>

<template>
  <div class="flex items-center gap-0.5 rounded-lg bg-panel p-0.5" role="group" aria-label="主题模式">
    <button
      v-for="theme in themes"
      :key="theme.id"
      class="h-6 w-8 inline-flex items-center justify-center rounded-md cursor-pointer transition-colors"
      :class="workspaceStore.theme === theme.id ? 'bg-accent-soft text-accent' : 'text-text-muted hover:bg-accent-soft'"
      :title="theme.label"
      :aria-label="theme.label"
      :aria-pressed="workspaceStore.theme === theme.id"
      @click="workspaceStore.setTheme(theme.id)"
    >
      <component :is="theme.icon" :size="14" />
    </button>
  </div>
</template>
