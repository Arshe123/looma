<script setup lang="ts">
import type { Component } from 'vue'
import type { SettingsSectionId } from '@/renderer/stores/workspace'

defineProps<{
  sections: readonly {
    id: SettingsSectionId
    title: string
    description: string
    icon: Component
  }[]
  activeSection: SettingsSectionId
}>()

const emit = defineEmits<{
  'update:activeSection': [section: SettingsSectionId]
}>()
</script>

<template>
  <nav
    class="shrink-0 rounded-lg border border-border-soft bg-panel p-2 lg:w-32"
    aria-label="设置分类"
    data-testid="settings-section-nav"
  >
    <button
      v-for="section in sections"
      :key="section.id"
      type="button"
      class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors"
      :class="[
        activeSection === section.id
          ? 'bg-accent-soft text-text-main'
          : 'text-text-muted hover:bg-accent-soft hover:text-text-main'
      ]"
      data-testid="settings-section-button"
      @click="emit('update:activeSection', section.id)"
    >
      <span
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
        :class="activeSection === section.id ? 'bg-panel text-accent' : 'bg-panel-soft text-text-muted'"
      >
        <component :is="section.icon" :size="16" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-medium">{{ section.title }}</span>
      </span>
    </button>
  </nav>
</template>
