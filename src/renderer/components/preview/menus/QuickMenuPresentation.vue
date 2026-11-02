<script setup lang="ts">
import TableSizePicker from '../TableSizePicker.vue'
import type { MenuPresentationItem } from './menuPresentation'
withDefaults(defineProps<{
  items: readonly MenuPresentationItem[]
  selectedIndex?: number
  tablePickerVisible?: boolean
}>(), { selectedIndex: 0, tablePickerVisible: false })
const emit = defineEmits<{
  action: [id: string]
  hover: [index: number]
  'table-size': [size: { rows: number; cols: number }]
}>()
</script>

<template>
  <div role="menu" aria-label="快速插入菜单" class="w-56 bg-panel border border-border-soft rounded-lg shadow-xl z-20 py-1 overflow-y-auto max-h-[220px]">
    <button
      v-for="(item, index) in items"
      :key="item.id"
      type="button"
      role="menuitem"
      :data-action="item.id"
      :disabled="item.disabled"
      class="w-full text-left flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      :class="{
        'bg-accent-soft text-accent': index === selectedIndex,
        'text-text-main hover:bg-accent-soft/50': index !== selectedIndex
      }"
      @click="!item.disabled && emit('action', item.id)"
      @mouseenter="emit('hover', index)"
    >
      <component :is="item.icon" v-if="item.icon" :size="16" />
      <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
      <span v-if="item.shortcut" class="shrink-0 rounded border border-border-soft bg-panel-soft px-1.5 py-0.5 text-[9px] text-text-muted">{{ item.shortcut }}</span>
    </button>
    <div v-if="tablePickerVisible" class="px-3 py-2">
      <TableSizePicker @select="emit('table-size', $event)" />
    </div>
    <slot />
  </div>
</template>
