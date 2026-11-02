<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import TableSizePicker from '../TableSizePicker.vue'
import type { MenuPresentationItem } from './menuPresentation'
withDefaults(defineProps<{
  mode?: 'default' | 'table'
  textStyleIcons?: readonly MenuPresentationItem[]
  blockStyleIcons?: readonly MenuPresentationItem[]
  listItems?: readonly MenuPresentationItem[]
  tableItems?: readonly MenuPresentationItem[]
  clipboardItems?: readonly MenuPresentationItem[]
  tablePickerVisible?: boolean
}>(), { mode: 'default', textStyleIcons: () => [], blockStyleIcons: () => [], listItems: () => [], tableItems: () => [], clipboardItems: () => [], tablePickerVisible: false })
const emit = defineEmits<{
  action: [id: string]
  'table-size': [size: { rows: number; cols: number }]
}>()
const root = ref<HTMLElement | null>(null)
const submenu = ref<HTMLElement | null>(null)
const activeItem = ref<MenuPresentationItem | null>(null)
const submenuPosition = ref({ top: 0, left: 0 })
const openSubmenu = (item: MenuPresentationItem, event: Event) => {
  activeItem.value = item.children ? item : null
  const target = event.currentTarget as HTMLElement
  if (!item.children) return
  nextTick(() => {
    if (!root.value || !submenu.value || activeItem.value?.id !== item.id) return
    const menu = root.value.getBoundingClientRect(), sub = submenu.value.getBoundingClientRect(), row = target.getBoundingClientRect()
    submenuPosition.value = {
      top: Math.max(8, Math.min(row.top, window.innerHeight - sub.height - 10)),
      left: menu.right + sub.width > window.innerWidth ? Math.max(8, menu.left - sub.width) : menu.right,
    }
  })
}
const activate = (item: MenuPresentationItem) => { if (!item.disabled) emit('action', item.id) }
let rightDragMoved = false
const trackRightDrag = (event: PointerEvent) => {
  if (event.buttons & 2) rightDragMoved = true
}
const releaseAction = (item: MenuPresentationItem, event: PointerEvent) => {
  // A clamped menu can appear under a stationary opening pointer. Only a
  // deliberate held-button move may turn its release into an action.
  if (event.button !== 2 || !rightDragMoved) return
  rightDragMoved = false
  event.preventDefault()
  event.stopPropagation()
  if (item.children) openSubmenu(item, event)
  else activate(item)
}
</script>

<template>
  <div ref="root" role="menu" aria-label="编辑菜单" class="w-64 bg-panel border border-border-soft rounded-lg shadow-xl py-2 pointer-events-auto flex flex-col" @contextmenu.prevent @pointermove="trackRightDrag">
    <div v-if="mode === 'default'" class="flex flex-col">
      <div class="flex flex-col gap-2 px-3 py-1.5" @mouseenter="activeItem = null">
        <template v-for="(items, gridIndex) in [textStyleIcons, blockStyleIcons]" :key="gridIndex">
          <div v-if="gridIndex" class="h-px bg-accent-soft my-1"></div>
          <div class="flex flex-wrap justify-center gap-1.5">
            <button v-for="item in items" :key="item.id" type="button" role="menuitem" :data-action="item.id" :disabled="item.disabled" :title="item.label" :aria-label="item.label"
              class="flex items-center justify-center w-8 h-8 rounded bg-panel border border-border-soft hover:bg-accent-soft text-text-main transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              @click="activate(item)" @pointerup="releaseAction(item, $event)">
              <component :is="item.icon" v-if="item.icon" :size="15" />
            </button>
          </div>
        </template>
        <div v-if="tablePickerVisible" class="flex justify-center pt-1"><TableSizePicker @select="emit('table-size', $event)" /></div>
      </div>
      <div class="h-px bg-accent-soft my-1"></div>
      <div class="px-1 flex flex-col gap-0.5">
        <button v-for="item in listItems" :key="item.id" type="button" role="menuitem" :data-action="item.id" :disabled="item.disabled" :aria-haspopup="item.children ? 'menu' : undefined" :aria-expanded="item.children ? activeItem?.id === item.id : undefined"
          class="relative flex items-center justify-between px-3 py-1.5 text-sm text-text-main hover:bg-accent-soft cursor-pointer rounded mx-1 transition-colors text-left"
          @click="item.children ? openSubmenu(item, $event) : activate(item)" @pointerup="releaseAction(item, $event)" @mouseenter="openSubmenu(item, $event)" @keydown.right.prevent="openSubmenu(item, $event)">
          <span class="flex items-center gap-3"><component :is="item.icon" v-if="item.icon" :size="15" class="text-text-muted" /><span>{{ item.label }}</span></span>
          <ChevronRight v-if="item.children" :size="14" class="text-text-subtle" />
        </button>
      </div>
    </div>
    <div v-else class="px-1 py-1 flex flex-col gap-0.5">
      <button v-for="item in tableItems" :key="item.id" type="button" role="menuitem" :data-action="item.id" :disabled="item.disabled"
        class="flex items-center gap-3 px-3 py-1.5 text-sm text-text-main hover:bg-accent-soft cursor-pointer rounded mx-1 transition-colors text-left disabled:opacity-40" @click="activate(item)" @pointerup="releaseAction(item, $event)">
        <component :is="item.icon" v-if="item.icon" :size="15" class="text-text-muted" /><span>{{ item.label }}</span>
      </button>
    </div>
    <div class="h-px bg-accent-soft my-1"></div>
    <div class="px-1 pb-1 flex flex-col gap-0.5">
      <button v-for="item in clipboardItems" :key="item.id" type="button" role="menuitem" :data-action="item.id" :disabled="item.disabled"
        class="flex items-center justify-between gap-3 px-3 py-1.5 text-sm text-text-main hover:bg-accent-soft cursor-pointer rounded mx-1 transition-colors text-left disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent" @click="activate(item)" @pointerup="releaseAction(item, $event)">
        <span class="flex items-center gap-3"><component :is="item.icon" v-if="item.icon" :size="15" class="text-text-muted" />{{ item.label }}</span>
        <span v-if="item.shortcut" class="text-xs text-text-subtle">{{ item.shortcut }}</span>
      </button>
    </div>
    <div v-if="activeItem" ref="submenu" role="menu" aria-label="段落" class="fixed w-48 bg-panel border border-border-soft rounded-lg shadow-xl py-1 pointer-events-auto" :style="{ top: `${submenuPosition.top}px`, left: `${submenuPosition.left}px` }" @keydown.left.prevent="activeItem = null">
      <button v-for="item in activeItem.children" :key="item.id" type="button" role="menuitem" :data-action="item.id" :disabled="item.disabled"
        class="w-full text-left flex items-center gap-3 px-4 py-2 text-sm text-text-main hover:bg-accent-soft cursor-pointer transition-colors" @click="activate(item)" @pointerup="releaseAction(item, $event)">
        <component :is="item.icon" v-if="item.icon" :size="16" class="text-text-muted" /><span>{{ item.label }}</span>
      </button>
    </div>
    <slot />
  </div>
</template>
