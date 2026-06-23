<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  clampTableSize,
  MAX_TABLE_SIZE,
  TABLE_PICKER_GRID_COLS,
  TABLE_PICKER_GRID_ROWS,
} from '@/shared/utils/tiptap-table-utils'

type PickerCell = {
  key: string
  row: number
  col: number
}

const props = withDefaults(defineProps<{
  gridRows?: number
  gridCols?: number
  mode?: 'insert' | 'resize'
  currentRows?: number
  currentCols?: number
}>(), {
  gridRows: TABLE_PICKER_GRID_ROWS,
  gridCols: TABLE_PICKER_GRID_COLS,
  mode: 'insert',
  currentRows: 0,
  currentCols: 0,
})

const emit = defineEmits<{
  (e: 'select', value: { rows: number; cols: number }): void
}>()

const hoverRows = ref(3)
const hoverCols = ref(3)
const manualRows = ref<number | string>(3)
const manualCols = ref<number | string>(3)

const rows = computed(() => Array.from({ length: props.gridRows }, (_, index) => index + 1))
const cols = computed(() => Array.from({ length: props.gridCols }, (_, index) => index + 1))
const cells = computed(() =>
  rows.value.flatMap(row =>
    cols.value.map(col => ({
      key: `${row}-${col}`,
      row,
      col,
    })),
  ),
)
const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${props.gridCols}, 1rem)`,
}))
const isResizeMode = computed(() => props.mode === 'resize')
const currentSize = computed(() => clampTableSize(props.currentRows, props.currentCols))
const hasCurrentSize = computed(() => isResizeMode.value && props.currentRows > 0 && props.currentCols > 0)

const applyPreviewSize = (size: { rows: number; cols: number }) => {
  hoverRows.value = size.rows
  hoverCols.value = size.cols
  manualRows.value = size.rows
  manualCols.value = size.cols
}

const isCurrentSizeCell = (cell: PickerCell) => (
  hasCurrentSize.value
  && cell.row <= currentSize.value.rows
  && cell.col <= currentSize.value.cols
)

const setHover = (row: number, col: number) => {
  const size = clampTableSize(row, col, props.gridRows, props.gridCols)
  applyPreviewSize(size)
}

const selectSize = (row: number, col: number) => {
  emit('select', clampTableSize(row, col))
}

const syncManualPreview = () => {
  const size = clampTableSize(Number(manualRows.value), Number(manualCols.value))
  hoverRows.value = size.rows
  hoverCols.value = size.cols
}

const normalizeManualInputs = () => {
  const size = clampTableSize(Number(manualRows.value), Number(manualCols.value))
  manualRows.value = size.rows
  manualCols.value = size.cols
  syncManualPreview()
  return size
}

const selectManualSize = () => {
  emit('select', normalizeManualInputs())
}

watch(
  () => [props.mode, props.currentRows, props.currentCols] as const,
  () => {
    if (!hasCurrentSize.value) return
    applyPreviewSize(currentSize.value)
  },
  { immediate: true },
)
</script>

<template>
  <div class="table-size-picker">
    <div class="table-size-picker__label">{{ hoverRows }} x {{ hoverCols }}</div>
    <div class="table-size-picker__grid" :style="gridStyle">
      <button
        v-for="cell in cells"
        :key="cell.key"
        type="button"
        class="table-size-picker__cell"
        :class="{
          'table-size-picker__cell--active': cell.row <= hoverRows && cell.col <= hoverCols,
          'table-size-picker__cell--current': isCurrentSizeCell(cell),
        }"
        :title="`${cell.row} x ${cell.col}`"
        @mouseenter="setHover(cell.row, cell.col)"
        @focus="setHover(cell.row, cell.col)"
        @click="selectSize(cell.row, cell.col)"
      />
    </div>
    <form class="table-size-picker__manual" @submit.prevent="selectManualSize">
      <label class="table-size-picker__field">
        <span>行</span>
        <input
          v-model.number="manualRows"
          type="number"
          min="1"
          :max="MAX_TABLE_SIZE"
          step="1"
          aria-label="表格行数"
          @input="syncManualPreview"
          @blur="normalizeManualInputs"
        >
      </label>
      <label class="table-size-picker__field">
        <span>列</span>
        <input
          v-model.number="manualCols"
          type="number"
          min="1"
          :max="MAX_TABLE_SIZE"
          step="1"
          aria-label="表格列数"
          @input="syncManualPreview"
          @blur="normalizeManualInputs"
        >
      </label>
      <button type="submit" class="table-size-picker__submit">确定</button>
    </form>
  </div>
</template>

<style scoped>
.table-size-picker {
  width: max-content;
  padding: 0.55rem;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  color: var(--text-main);
  background: var(--panel);
  box-shadow: 0 16px 40px rgb(0 0 0 / 16%);
}

.table-size-picker__label {
  margin-bottom: 0.45rem;
  color: var(--text-muted);
  font-size: 0.74rem;
  font-weight: 600;
  line-height: 1;
  text-align: center;
}

.table-size-picker__grid {
  display: grid;
  gap: 0.18rem;
}

.table-size-picker__cell {
  width: 1rem;
  height: 1rem;
  border: 1px solid var(--border-soft);
  border-radius: 3px;
  background: var(--panel-soft);
  transition: border-color 100ms ease, background 100ms ease;
}

.table-size-picker__cell--active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.table-size-picker__cell--current {
  border-color: rgb(120 120 120 / 55%);
  background: rgb(120 120 120 / 26%);
}

.table-size-picker__cell--current.table-size-picker__cell--active {
  border-color: var(--accent);
}

.table-size-picker__manual {
  display: grid;
  grid-template-columns: repeat(2, 3.25rem) auto;
  gap: 0.35rem;
  align-items: end;
  margin-top: 0.55rem;
}

.table-size-picker__field {
  display: grid;
  gap: 0.2rem;
  color: var(--text-muted);
  font-size: 0.68rem;
  font-weight: 600;
}

.table-size-picker__field input {
  width: 100%;
  min-width: 0;
  height: 1.75rem;
  border: 1px solid var(--border-soft);
  border-radius: 5px;
  padding: 0 0.35rem;
  color: var(--text-main);
  background: var(--panel-soft);
  font-size: 0.78rem;
}

.table-size-picker__field input:focus {
  border-color: var(--accent);
  outline: none;
}

.table-size-picker__submit {
  height: 1.75rem;
  border: 1px solid var(--border-soft);
  border-radius: 5px;
  padding: 0 0.45rem;
  color: var(--text-main);
  background: var(--panel-soft);
  font-size: 0.74rem;
  font-weight: 600;
}

.table-size-picker__submit:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}
</style>
