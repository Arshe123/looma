<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Eye, EyeOff, Github, LockKeyhole, Mail, X } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  open: boolean
  initialMode?: 'login' | 'register'
}>(), {
  initialMode: 'login',
})

const emit = defineEmits<{
  (e: 'close'): void
}>()

const authMode = ref<'login' | 'register'>('login')
const authMethod = ref<'email' | 'code'>('email')
const showPassword = ref(false)
const showConfirmPassword = ref(false)

const authTitle = computed(() => (authMode.value === 'login' ? '登录' : '注册'))
const authDescription = computed(() =>
  authMode.value === 'login' ? '欢迎回来，登录以继续使用 with-you' : '创建账号，开启你的 with-you 之旅',
)

const close = () => {
  emit('close')
}

const switchAuthMode = (mode: 'login' | 'register') => {
  authMode.value = mode
  authMethod.value = 'email'
}

watch(
  () => [props.open, props.initialMode] as const,
  ([open, mode]) => {
    if (!open) return
    switchAuthMode(mode)
  },
)
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-overlay flex items-center justify-center p-6"
    @pointerdown.self="close"
  >
    <div
      class="w-[424px] max-w-[92vw] rounded-xl border border-border-soft bg-panel shadow-2xl shadow-black/25 px-8 py-7"
      @pointerdown.stop
    >
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-2xl font-bold text-text-main">{{ authTitle }}</h2>
          <p class="mt-1 text-sm text-text-muted">{{ authDescription }}</p>
        </div>
        <button
          class="w-8 h-8 inline-flex items-center justify-center rounded-md text-text-muted hover:bg-accent-soft hover:text-text-main cursor-pointer"
          title="关闭"
          @click="close"
        >
          <X :size="18" />
        </button>
      </div>

      <div class="mt-7 grid grid-cols-2 border-b border-border-soft">
        <button
          class="h-10 text-sm font-semibold border-b-2 cursor-pointer"
          :class="authMethod === 'email' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-main'"
          @click="authMethod = 'email'"
        >
          {{ authMode === 'login' ? '邮箱登录' : '邮箱注册' }}
        </button>
        <button
          class="h-10 text-sm font-semibold border-b-2 cursor-pointer"
          :class="authMethod === 'code' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-main'"
          @click="authMethod = 'code'"
        >
          {{ authMode === 'login' ? '验证码登录' : '验证码注册' }}
        </button>
      </div>

      <div class="mt-5 space-y-4">
        <label class="block">
          <span class="text-sm font-semibold text-text-main">邮箱地址</span>
          <span class="mt-2 flex items-center gap-2 h-11 px-3 rounded-lg border border-border-soft bg-surface">
            <Mail :size="18" class="text-text-muted shrink-0" />
            <input
              class="min-w-0 flex-1 bg-transparent outline-hidden text-sm text-text-main placeholder:text-text-subtle"
              placeholder="请输入邮箱地址"
            />
          </span>
        </label>

        <label class="block">
          <span class="text-sm font-semibold text-text-main">
            {{ authMethod === 'email' ? '密码' : '验证码' }}
          </span>
          <span class="mt-2 flex items-center gap-2 h-11 px-3 rounded-lg border border-border-soft bg-surface">
            <LockKeyhole :size="18" class="text-text-muted shrink-0" />
            <input
              class="min-w-0 flex-1 bg-transparent outline-hidden text-sm text-text-main placeholder:text-text-subtle"
              :type="authMethod === 'email' && !showPassword ? 'password' : 'text'"
              :placeholder="authMethod === 'email' ? (authMode === 'login' ? '请输入密码' : '请输入密码（至少 6 位）') : '请输入验证码'"
            />
            <button
              v-if="authMethod === 'email'"
              type="button"
              class="w-8 h-8 inline-flex items-center justify-center rounded-md text-text-muted hover:bg-accent-soft hover:text-text-main cursor-pointer"
              title="显示或隐藏密码"
              @click="showPassword = !showPassword"
            >
              <EyeOff v-if="showPassword" :size="17" />
              <Eye v-else :size="17" />
            </button>
          </span>
        </label>

        <label v-if="authMode === 'register' && authMethod === 'email'" class="block">
          <span class="text-sm font-semibold text-text-main">确认密码</span>
          <span class="mt-2 flex items-center gap-2 h-11 px-3 rounded-lg border border-border-soft bg-surface">
            <LockKeyhole :size="18" class="text-text-muted shrink-0" />
            <input
              class="min-w-0 flex-1 bg-transparent outline-hidden text-sm text-text-main placeholder:text-text-subtle"
              :type="showConfirmPassword ? 'text' : 'password'"
              placeholder="请再次输入密码"
            />
            <button
              type="button"
              class="w-8 h-8 inline-flex items-center justify-center rounded-md text-text-muted hover:bg-accent-soft hover:text-text-main"
              title="显示或隐藏确认密码"
              @click="showConfirmPassword = !showConfirmPassword"
            >
              <EyeOff v-if="showConfirmPassword" :size="17" />
              <Eye v-else :size="17" />
            </button>
          </span>
        </label>
      </div>

      <div v-if="authMode === 'login'" class="mt-5 flex items-center justify-between gap-3">
        <label class="inline-flex items-center gap-2 text-sm text-text-muted cursor-pointer">
          <input type="checkbox" class="w-4 h-4 rounded border-border-soft accent-[var(--accent)]" />
          <span>记住我</span>
        </label>
        <button class="text-sm font-semibold text-accent hover:text-accent-hover cursor-pointer">忘记密码?</button>
      </div>

      <label v-else class="mt-5 flex items-center gap-2 text-sm text-text-muted cursor-pointer">
        <input type="checkbox" class="w-4 h-4 rounded border-border-soft accent-[var(--accent)]" />
        <span>
          我已阅读并同意
          <button class="font-semibold text-accent hover:text-accent-hover cursor-pointer">《用户协议》</button>
          和
          <button class="font-semibold text-accent hover:text-accent-hover cursor-pointer">《隐私政策》</button>
        </span>
      </label>

      <button class="mt-7 w-full h-11 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-semibold cursor-pointer">
        {{ authTitle }}
      </button>

      <div class="my-5 flex items-center gap-4">
        <div class="h-px flex-1 bg-border-soft"></div>
        <div class="text-sm text-text-muted">或</div>
        <div class="h-px flex-1 bg-border-soft"></div>
      </div>

      <button
        class="w-full h-11 rounded-lg border border-border-soft bg-panel hover:bg-panel-soft text-sm font-semibold text-text-main inline-flex items-center justify-center gap-2 cursor-pointer"
      >
        <Github :size="18" />
        <span>{{ authMode === 'login' ? '使用 GitHub 账号登录' : '使用 GitHub 账号注册' }}</span>
      </button>

      <div class="mt-6 text-center text-sm text-text-muted">
        <template v-if="authMode === 'login'">
          还没有账号？
          <button class="font-semibold text-accent hover:text-accent-hover cursor-pointer" @click="switchAuthMode('register')">立即注册</button>
        </template>
        <template v-else>
          已有账号？
          <button class="font-semibold text-accent hover:text-accent-hover cursor-pointer" @click="switchAuthMode('login')">立即登录</button>
        </template>
      </div>
    </div>
  </div>
</template>
