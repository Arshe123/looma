<script setup lang="ts">
import { Copy, TableProperties, Trash2 } from 'lucide-vue-next'
import TableSizePicker from '../TableSizePicker.vue'
withDefaults(defineProps<{
  sizePickerVisible?: boolean
  currentTableSize?: { rows: number; cols: number }
}>(), { sizePickerVisible: false, currentTableSize: () => ({ rows: 3, cols: 3 }) })
const emit = defineEmits<{
  size: []
  copy: []
  delete: []
  resize: [size: { rows: number; cols: number }]
}>()
</script>
<template>
  <div class="table-toolbar" role="toolbar" aria-label="表格操作">
    <button type="button" title="调整表格大小" aria-label="调整表格大小" :aria-expanded="sizePickerVisible" @click="emit('size')"><TableProperties :size="15" /></button>
    <button type="button" title="复制表格" aria-label="复制表格" @click="emit('copy')"><Copy :size="15" /></button>
    <button type="button" title="删除表格" aria-label="删除表格" @click="emit('delete')"><Trash2 :size="15" /></button>
    <div v-if="sizePickerVisible" class="table-toolbar__picker">
      <TableSizePicker mode="resize" :current-rows="currentTableSize.rows" :current-cols="currentTableSize.cols" @select="emit('resize', $event)" />
    </div>
  </div>
</template>

<style scoped>
.table-toolbar {
  position: relative;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0.25rem;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 14px 36px rgb(0 0 0 / 14%);
}

.table-toolbar > button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.8rem;
  height: 1.8rem;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  transition: color 100ms ease, background 100ms ease, border-color 100ms ease;
}

.table-toolbar > button:hover {
  border-color: var(--border-soft);
  color: var(--text-main);
  background: var(--accent-soft);
}

.table-toolbar__picker {
  position: absolute;
  top: calc(100% + 0.35rem);
  left: 0;
}
</style>
