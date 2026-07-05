<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue'
import { Eye, EyeOff, KeyRound, LockKeyhole, Mail, X } from 'lucide-vue-next'
import {
  loginByPassword,
  registerByEmail,
  sendMailCode,
  verifyMailCode,
  type AuthScene,
  type LoginUser,
} from '@/renderer/services/authApi'

const props = withDefaults(defineProps<{
  open: boolean
  initialMode?: AuthScene
}>(), {
  initialMode: 'login',
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'authenticated', payload: { email: string; user: LoginUser }): void
}>()

const authMode = ref<AuthScene>('login')
const loginMethod = ref<'password' | 'code'>('password')
const showPassword = ref(false)
const showConfirmPassword = ref(false)
const loading = ref(false)
const sendingCode = ref(false)
const countdown = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
let countdownTimer: number | null = null

const form = reactive({
  email: '',
  password: '',
  confirmPassword: '',
  code: '',
  agreeTerms: false,
})

const needsCode = computed(() => authMode.value === 'register' || loginMethod.value === 'code')
const authTitle = computed(() => {
  if (authMode.value === 'register') return '邮箱注册'
  return loginMethod.value === 'password' ? '密码登录' : '验证码登录'
})
const authDescription = computed(() => {
  if (authMode.value === 'register') return '输入密码，并用邮箱验证码验证邮箱'
  return loginMethod.value === 'password' ? '使用邮箱和密码登录 looma' : '使用邮箱验证码登录 looma'
})
const submitText = computed(() => {
  if (loading.value) return authMode.value === 'register' ? '注册中...' : '登录中...'
  return authMode.value === 'register' ? '注册并登录' : '登录'
})
const sendCodeText = computed(() => {
  if (sendingCode.value) return '发送中...'
  if (countdown.value > 0) return `${countdown.value}s 后重发`
  return '发送验证码'
})

const resetFeedback = () => {
  errorMessage.value = ''
  successMessage.value = ''
}

const stopCountdown = () => {
  if (countdownTimer !== null) {
    window.clearInterval(countdownTimer)
    countdownTimer = null
  }
}

const startCountdown = () => {
  stopCountdown()
  countdown.value = 60
  countdownTimer = window.setInterval(() => {
    countdown.value -= 1
    if (countdown.value <= 0) {
      countdown.value = 0
      stopCountdown()
    }
  }, 1000)
}

const close = () => {
  if (loading.value || sendingCode.value) return
  emit('close')
}

const switchAuthMode = (mode: AuthScene) => {
  authMode.value = mode
  form.code = ''
  form.agreeTerms = false
  countdown.value = 0
  stopCountdown()
  resetFeedback()
}

const switchLoginMethod = (method: 'password' | 'code') => {
  loginMethod.value = method
  form.code = ''
  resetFeedback()
}

const validateEmail = () => {
  const email = form.email.trim()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '请输入有效的邮箱地址'
  return ''
}

const validatePassword = () => {
  if (form.password.length < 6) return '密码长度不能少于 6 位'
  return ''
}

const sendCode = async () => {
  resetFeedback()
  const emailError = validateEmail()
  if (emailError) {
    errorMessage.value = emailError
    return
  }
  if (countdown.value > 0) return

  sendingCode.value = true
  try {
    await sendMailCode({ email: form.email.trim(), scene: authMode.value })
    successMessage.value = '验证码已发送，请查看邮箱。'
    startCountdown()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '验证码发送失败，请稍后重试'
  } finally {
    sendingCode.value = false
  }
}

const validateSubmit = () => {
  const emailError = validateEmail()
  if (emailError) return emailError

  if (authMode.value === 'login' && loginMethod.value === 'password') {
    return validatePassword()
  }

  if (authMode.value === 'register') {
    const passwordError = validatePassword()
    if (passwordError) return passwordError
    if (form.password !== form.confirmPassword) return '两次输入的密码不一致'
    if (!form.agreeTerms) return '请先阅读并同意用户协议和隐私政策'
  }

  if (!/^[A-Za-z0-9]{6}$/.test(form.code.trim())) return '请输入邮箱验证码'
  return ''
}

const submit = async () => {
  resetFeedback()
  const validationError = validateSubmit()
  if (validationError) {
    errorMessage.value = validationError
    return
  }

  loading.value = true
  try {
    const email = form.email.trim()
    const user = authMode.value === 'register'
      ? await registerByEmail({ email, password: form.password, code: form.code, scene: 'register' })
      : loginMethod.value === 'password'
        ? await loginByPassword({ email, password: form.password })
        : await verifyMailCode({ email, code: form.code, scene: 'login' })

    successMessage.value = authMode.value === 'register' ? '注册成功，已自动登录。' : '登录成功。'
    emit('authenticated', { email, user })
    form.password = ''
    form.confirmPassword = ''
    form.code = ''
    form.agreeTerms = false
    stopCountdown()
    countdown.value = 0
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '操作失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.open, props.initialMode] as const,
  ([open, mode]) => {
    if (!open) return
    switchAuthMode(mode)
  },
)

onUnmounted(stopCountdown)
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-50 bg-overlay flex items-center justify-center p-6"
    @pointerdown.self="close"
  >
    <form
      class="w-[424px] max-w-[92vw] rounded-xl border border-border-soft bg-panel shadow-2xl shadow-black/25 px-8 py-7"
      @pointerdown.stop
      @submit.prevent="submit"
    >
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-2xl font-bold text-text-main">{{ authTitle }}</h2>
          <p class="mt-1 text-sm text-text-muted">{{ authDescription }}</p>
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

      <div class="mt-7 grid grid-cols-2 border-b border-border-soft">
        <button
          type="button"
          class="h-10 text-sm font-semibold border-b-2 cursor-pointer"
          :class="authMode === 'login' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-main'"
          @click="switchAuthMode('login')"
        >
          登录
        </button>
        <button
          type="button"
          class="h-10 text-sm font-semibold border-b-2 cursor-pointer"
          :class="authMode === 'register' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-main'"
          @click="switchAuthMode('register')"
        >
          注册
        </button>
      </div>

      <div v-if="authMode === 'login'" class="mt-4 grid grid-cols-2 gap-2 rounded-lg bg-surface p-1">
        <button
          type="button"
          class="h-8 rounded-md text-sm font-semibold cursor-pointer"
          :class="loginMethod === 'password' ? 'bg-panel text-text-main shadow-sm' : 'text-text-muted hover:text-text-main'"
          @click="switchLoginMethod('password')"
        >
          密码登录
        </button>
        <button
          type="button"
          class="h-8 rounded-md text-sm font-semibold cursor-pointer"
          :class="loginMethod === 'code' ? 'bg-panel text-text-main shadow-sm' : 'text-text-muted hover:text-text-main'"
          @click="switchLoginMethod('code')"
        >
          验证码登录
        </button>
      </div>

      <div class="mt-5 space-y-4">
        <label class="block">
          <span class="text-sm font-semibold text-text-main">邮箱地址</span>
          <span class="mt-2 flex items-center gap-2 h-11 px-3 rounded-lg border border-border-soft bg-surface">
            <Mail :size="18" class="text-text-muted shrink-0" />
            <input
              v-model.trim="form.email"
              class="min-w-0 flex-1 bg-transparent outline-hidden text-sm text-text-main placeholder:text-text-subtle"
              placeholder="请输入邮箱地址"
              autocomplete="email"
            />
          </span>
        </label>

        <label v-if="authMode === 'register' || loginMethod === 'password'" class="block">
          <span class="text-sm font-semibold text-text-main">密码</span>
          <span class="mt-2 flex items-center gap-2 h-11 px-3 rounded-lg border border-border-soft bg-surface">
            <LockKeyhole :size="18" class="text-text-muted shrink-0" />
            <input
              v-model="form.password"
              class="min-w-0 flex-1 bg-transparent outline-hidden text-sm text-text-main placeholder:text-text-subtle"
              :type="showPassword ? 'text' : 'password'"
              :placeholder="authMode === 'register' ? '请输入密码（至少 6 位）' : '请输入密码'"
              autocomplete="current-password"
            />
            <button
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

        <label v-if="authMode === 'register'" class="block">
          <span class="text-sm font-semibold text-text-main">确认密码</span>
          <span class="mt-2 flex items-center gap-2 h-11 px-3 rounded-lg border border-border-soft bg-surface">
            <LockKeyhole :size="18" class="text-text-muted shrink-0" />
            <input
              v-model="form.confirmPassword"
              class="min-w-0 flex-1 bg-transparent outline-hidden text-sm text-text-main placeholder:text-text-subtle"
              :type="showConfirmPassword ? 'text' : 'password'"
              placeholder="请再次输入密码"
              autocomplete="new-password"
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

        <label v-if="needsCode" class="block">
          <span class="text-sm font-semibold text-text-main">邮箱验证码</span>
          <span class="mt-2 flex items-center gap-2 h-11 px-3 rounded-lg border border-border-soft bg-surface">
            <KeyRound :size="18" class="text-text-muted shrink-0" />
            <input
              v-model.trim="form.code"
              class="min-w-0 flex-1 bg-transparent outline-hidden text-sm text-text-main placeholder:text-text-subtle"
              inputmode="numeric"
              placeholder="请输入验证码"
              autocomplete="one-time-code"
            />
            <button
              type="button"
              :disabled="sendingCode || countdown > 0"
              class="shrink-0 rounded-md px-2.5 py-1.5 text-xs font-semibold text-accent hover:bg-accent-soft disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              @click="sendCode"
            >
              {{ sendCodeText }}
            </button>
          </span>
        </label>
      </div>

      <label v-if="authMode === 'register'" class="mt-5 flex items-center gap-2 text-sm text-text-muted cursor-pointer">
        <input v-model="form.agreeTerms" type="checkbox" class="w-4 h-4 rounded border-border-soft accent-[var(--accent)]" />
        <span>
          我已阅读并同意
          <button type="button" class="font-semibold text-accent hover:text-accent-hover cursor-pointer">《用户协议》</button>
          和
          <button type="button" class="font-semibold text-accent hover:text-accent-hover cursor-pointer">《隐私政策》</button>
        </span>
      </label>

      <p v-if="errorMessage" class="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
        {{ errorMessage }}
      </p>
      <p v-if="successMessage" class="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-500">
        {{ successMessage }}
      </p>

      <button
        type="submit"
        :disabled="loading"
        class="mt-7 w-full h-11 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold cursor-pointer"
      >
        {{ submitText }}
      </button>

      <div class="mt-6 text-center text-sm text-text-muted">
        <template v-if="authMode === 'login'">
          还没有账号？
          <button type="button" class="font-semibold text-accent hover:text-accent-hover cursor-pointer" @click="switchAuthMode('register')">立即注册</button>
        </template>
        <template v-else>
          已有账号？
          <button type="button" class="font-semibold text-accent hover:text-accent-hover cursor-pointer" @click="switchAuthMode('login')">去登录</button>
        </template>
      </div>
    </form>
  </div>
</template>
