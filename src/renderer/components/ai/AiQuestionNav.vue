<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = defineProps<{
  questions: { id: number; text: string }[]
  activeId: number | null
}>()
const emit = defineEmits<{ select: [id: number] }>()
const navRef = ref<HTMLElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const preview = ref<{ text: string; ordinal: number; top: number } | null>(null)

const showPreview = (event: MouseEvent | FocusEvent, ordinal: number) => {
  const button = event.currentTarget as HTMLElement
  const nav = navRef.value
  const question = props.questions[ordinal]
  if (!nav || !question) return
  const rect = nav.getBoundingClientRect()
  preview.value = {
    text: question.text || '（空问题）',
    ordinal: ordinal + 1,
    top: Math.max(0, Math.min(button.getBoundingClientRect().top - rect.top - 20, rect.height - 120)),
  }
}

watch(() => props.activeId, async () => {
  await nextTick()
  const list = listRef.value
  const active = list?.querySelector<HTMLElement>('[aria-current="step"]')
  if (!list || !active) return
  const top = active.offsetTop
  if (top < list.scrollTop) list.scrollTop = top
  else if (top + active.offsetHeight > list.scrollTop + list.clientHeight) {
    list.scrollTop = top + active.offsetHeight - list.clientHeight
  }
}, { immediate: true, flush: 'post' })
watch(() => props.questions, () => { preview.value = null })
</script>

<template>
  <nav v-if="questions.length" ref="navRef" class="ai-question-nav" aria-label="用户问题导航">
    <div ref="listRef" class="ai-question-nav-list" @scroll="preview = null" @mouseleave="preview = null">
      <button
        v-for="(question, index) in questions"
        :key="question.id"
        type="button"
        class="ai-question-mark"
        :class="{ 'is-active': question.id === activeId }"
        :aria-label="`第 ${index + 1} 轮：${question.text || '（空问题）'}`"
        :aria-current="question.id === activeId ? 'step' : undefined"
        @mouseenter="showPreview($event, index)"
        @focus="showPreview($event, index)"
        @blur="preview = null"
        @keydown.esc="preview = null"
        @click="emit('select', question.id)"
      >
        <span class="ai-question-line" :style="{ width: `${Math.min(22, 12 + Math.ceil(question.text.length / 12) * 2)}px` }" />
      </button>
    </div>
    <div v-if="preview" class="ai-question-preview border border-border-soft bg-panel text-text-main shadow-lg" :style="{ top: `${preview.top}px` }" role="tooltip">
      <div class="mb-1 text-[10px] text-text-subtle">第 {{ preview.ordinal }} 轮 · 点击定位</div>
      <div class="ai-question-preview-text text-xs leading-5">{{ preview.text }}</div>
    </div>
  </nav>
</template>

<style scoped>
.ai-question-nav {
  position: absolute;
  z-index: 10;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  width: 32px;
  max-height: min(360px, calc(100% - 32px));
}
.ai-question-nav-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
}
.ai-question-nav-list::-webkit-scrollbar { display: none; }
.ai-question-mark {
  display: flex;
  flex: 0 0 22px;
  align-items: center;
  justify-content: flex-end;
  width: 32px;
  padding: 0 3px;
  border-radius: 5px;
  cursor: pointer;
}
.ai-question-line {
  height: 3px;
  border-radius: 4px;
  background: var(--color-text-subtle);
  opacity: .4;
  transition: width .15s, opacity .15s;
}
.ai-question-mark.is-active .ai-question-line,
.ai-question-mark:hover .ai-question-line,
.ai-question-mark:focus-visible .ai-question-line {
  width: 26px !important;
  background: var(--color-accent);
  opacity: 1;
}
.ai-question-mark:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
.ai-question-preview {
  pointer-events: none;
  position: absolute;
  right: 40px;
  width: min(260px, calc(100vw - 90px));
  max-height: 180px;
  padding: 10px 12px;
  border-radius: 10px;
}
.ai-question-preview-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 6;
  overflow: hidden;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
@media (prefers-reduced-motion: reduce) {
  .ai-question-line { transition: none; }
}
</style>
