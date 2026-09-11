<script setup lang="ts">
import { useWorkspaceStore } from '@/renderer/stores/workspace'
import { THEME_PALETTES } from '@/renderer/theme'
import ThemeSwitcher from '../ThemeSwitcher.vue'
import FontSettings from './FontSettings.vue'

const workspaceStore = useWorkspaceStore()
</script>

<template>
  <div class="space-y-6 text-text-main">
    <header>
      <h2 class="text-base font-semibold">外观</h2>
      <p class="mt-1 text-sm text-text-muted">选择喜欢的配色，即时生效并自动记住，不会修改笔记内容。</p>
    </header>
    <section class="space-y-3" aria-label="外观模式">
      <h3 class="text-sm font-medium">外观模式</h3>
      <div class="flex flex-wrap items-center gap-3">
        <ThemeSwitcher />
        <span class="text-sm text-text-muted">{{ workspaceStore.theme === 'system' ? '跟随系统' : workspaceStore.theme === 'dark' ? '夜间模式' : '日间模式' }}</span>
      </div>
      <p class="text-xs text-text-muted">右下角的模式按钮与此处同步；跟随系统时仍保留所选配色。</p>
    </section>
    <section class="space-y-3" aria-label="主题配色">
      <h3 class="text-sm font-medium">主题配色</h3>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <button
          v-for="palette in THEME_PALETTES"
          :key="palette.id"
          type="button"
          :aria-label="palette.label"
          :aria-pressed="workspaceStore.themePalette === palette.id"
          class="min-w-0 cursor-pointer rounded-lg border p-3 text-left transition-colors"
          :class="workspaceStore.themePalette === palette.id ? 'border-accent bg-accent-soft' : 'border-border-soft hover:bg-panel-soft'"
          @click="workspaceStore.setThemePalette(palette.id)"
        >
          <span class="flex gap-2" aria-hidden="true">
            <span v-for="mode in ['light', 'dark']" :key="mode" :data-theme="mode" :data-palette="palette.id" class="palette-preview">
              <span class="palette-sidebar" />
              <span class="palette-document"><span /><span /><span /></span>
            </span>
          </span>
          <span class="mt-3 block text-sm font-medium">{{ palette.label }}{{ workspaceStore.themePalette === palette.id ? ' · 已选择' : '' }}</span>
          <span class="mt-1 block text-xs text-text-muted">{{ palette.description }}</span>
        </button>
      </div>
      <p class="text-xs text-text-muted">每套配色均包含日间和夜间版本，预览依次展示两种外观。</p>
    </section>
    <button type="button" class="cursor-pointer rounded-md border border-border-soft px-3 py-2 text-sm hover:bg-panel-soft" @click="workspaceStore.restoreDefaultTheme()">恢复默认主题</button>
    <p class="text-xs text-text-muted">默认使用暮纸配色并跟随系统。</p>
    <FontSettings />
  </div>
</template>

<style scoped>
.palette-preview { display: flex; flex: 1; min-width: 0; height: 72px; gap: 5px; padding: 6px; border: 1px solid var(--border-soft); border-radius: 6px; background: var(--bg); }
.palette-sidebar { width: 22%; border-radius: 3px; background: var(--panel-soft); }
.palette-document { display: flex; flex: 1; flex-direction: column; gap: 5px; padding: 8px 5px; border-radius: 3px; background: var(--surface); }
.palette-document span { height: 3px; border-radius: 2px; background: var(--border-soft); }
.palette-document span:first-child { width: 65%; background: var(--accent); }
</style>
