<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { AlertTriangle, Bug, HelpCircle, Lightbulb, LogIn, X } from 'lucide-vue-next'
import { submitFeedback, type FeedbackType } from '@/renderer/services/feedbackApi'

const props = defineProps<{
  open: boolean
  isLoggedIn: boolean
  userId?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'requireLogin'): void
  (e: 'submitted'): void
}>()

const MAX_LENGTH = 500

const feedbackTypes = [
  { value: 'BUG' as FeedbackType, label: '问题', icon: Bug },
  { value: 'ADVICE' as FeedbackType, label: '建议', icon: Lightbulb },
  { value: 'CONSULTATION' as FeedbackType, label: '咨询', icon: HelpCircle },
  { value: 'COMPLAINT' as FeedbackType, label: '投诉', icon: AlertTriangle },
]

const loading = ref(false)
const errorMessage = ref('')
const errorDetail = ref('')
const successMessage = ref('')

const form = reactive({
  feedbackType: 'BUG' as FeedbackType,
  content: '',
})

const remaining = computed(() => MAX_LENGTH - form.content.length)
const canSubmit = computed(() => props.isLoggedIn && form.content.trim().length > 0 && !loading.value)

const resetForm = () => {
  form.feedbackType = 'BUG'
  form.content = ''
  errorMessage.value = ''
  errorDetail.value = ''
  successMessage.value = ''
  loading.value = false
}

const close = () => {
  if (loading.value) return
  emit('close')
}

const selectType = (type: FeedbackType) => {
  form.feedbackType = type
}

const goLogin = () => {
  emit('requireLogin')
}

const submit = async () => {
  errorMessage.value = ''
  errorDetail.value = ''
  successMessage.value = ''

  if (!props.isLoggedIn) {
    errorMessage.value = '登录后才能提交反馈'
    return
  }
  const content = form.content.trim()
  if (!content) {
    errorMessage.value = '请填写问题描述'
    return
  }

  loading.value = true
  try {
    await submitFeedback({
      feedbackType: form.feedbackType,
      content,
      userId: props.userId,
    })
    successMessage.value = '反馈已提交，感谢你的反馈！我们会尽快跟进。'
    form.content = ''
    emit('submitted')
    window.setTimeout(() => {
      if (props.open) emit('close')
    }, 1400)
  } catch (error) {
    errorMessage.value = '提交失败，请稍后重试'
    errorDetail.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) resetForm()
  },
)
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-overlay flex items-center justify-center p-6"
    @pointerdown.self="close"
  >
    <form
      class="w-[432px] max-w-[92vw] rounded-xl border border-border-soft bg-panel shadow-2xl shadow-black/25 px-8 py-7"
      @pointerdown.stop
      @submit.prevent="submit"
    >
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-2xl font-bold text-text-main">报告问题</h2>
          <p class="mt-1 text-sm text-text-muted">把你遇到的问题告诉我们，我们会尽快跟进处理。</p>
        </div>
        <button
          type="button"
          class="w-8 h-8 inline-flex items-center justify-center rounded-md text-text-muted hover:bg-accent-soft hover:text-text-main cursor-pointer"
          title="关闭"
          @click="close"
        >
          <X :size="18" />
        </button>
      </div>

      <div
        v-if="!isLoggedIn"
        class="mt-6 flex items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5"
      >
        <span class="text-sm font-medium text-warning">登录后才能提交反馈</span>
        <button
          type="button"
          class="shrink-0 inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-semibold text-accent hover:bg-accent-soft cursor-pointer"
          @click="goLogin"
        >
          <LogIn :size="14" />
          <span>去登录</span>
        </button>
      </div>

      <div class="mt-6">
        <span class="text-sm font-semibold text-text-main">反馈类型</span>
        <div class="mt-2 grid grid-cols-4 gap-2">
          <button
            v-for="type in feedbackTypes"
            :key="type.value"
            type="button"
            class="h-10 rounded-lg border text-sm font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
            :class="form.feedbackType === type.value
              ? 'border-accent bg-accent-soft text-accent'
              : 'border-border-soft bg-surface text-text-muted hover:border-accent'"
            @click="selectType(type.value)"
          >
            <component :is="type.icon" :size="15" />
            <span>{{ type.label }}</span>
          </button>
        </div>
      </div>

      <div class="mt-5">
        <div class="flex items-center justify-between">
          <span class="text-sm font-semibold text-text-main">问题描述</span>
          <span
            class="text-xs"
            :class="remaining < 0 ? 'text-danger' : 'text-text-subtle'"
          >{{ form.content.length }}/{{ MAX_LENGTH }}</span>
        </div>
        <textarea
          v-model="form.content"
          :maxlength="MAX_LENGTH"
          rows="5"
          class="mt-2 w-full resize-y rounded-lg border border-border-soft bg-surface px-3 py-2.5 text-sm text-text-main placeholder:text-text-subtle outline-hidden focus:border-accent"
          placeholder="请描述你遇到的问题：操作步骤、预期结果、实际现象……"
        />
      </div>

      <p v-if="errorMessage" class="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
        {{ errorMessage }}
        <details v-if="errorDetail" class="mt-1">
          <summary class="cursor-pointer text-xs text-red-500/80 select-none">技术详情</summary>
          <span class="mt-1 block text-xs text-red-500/80 break-all">{{ errorDetail }}</span>
        </details>
      </p>
      <p v-if="successMessage" class="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-500">
        {{ successMessage }}
      </p>

      <button
        type="submit"
        :disabled="!canSubmit"
        class="mt-6 w-full h-11 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold cursor-pointer"
      >
        {{ loading ? '提交中...' : '提交反馈' }}
      </button>

      <p class="mt-4 text-center text-xs text-text-subtle">提交后我们会尽快处理，感谢你帮助 looma 变得更好。</p>
    </form>
  </div>
</template>
