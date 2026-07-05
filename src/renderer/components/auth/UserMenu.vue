<script setup lang="ts">
import { BookOpen, Bug, LogOut, MessageCircle, RefreshCw } from 'lucide-vue-next'

defineProps<{
  open: boolean
  isLoggedIn: boolean
  username: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'login'): void
  (e: 'register'): void
  (e: 'logout'): void
  (e: 'report'): void
  (e: 'checkUpdate'): void
}>()

type MenuAction = 'report' | 'checkUpdate' | undefined

const userMenuItems: { label: string; icon: typeof Bug; action?: MenuAction }[] = [
  { label: '检查更新', icon: RefreshCw, action: 'checkUpdate' },
  { label: '帮助文档', icon: BookOpen },
  { label: '联系我们', icon: MessageCircle },
  { label: '报告问题', icon: Bug, action: 'report' },
]

const close = () => {
  emit('close')
}

const handleItem = (action?: MenuAction) => {
  if (action === 'report') emit('report')
  if (action === 'checkUpdate') emit('checkUpdate')
  close()
}

const login = () => {
  emit('login')
}

const register = () => {
  emit('register')
}

const logout = () => {
  emit('logout')
}
</script>

<template>
  <div
    v-if="open"
    class="absolute left-full bottom-0 ml-2 w-56 rounded-xl border border-border-soft bg-panel shadow-2xl overflow-hidden z-50"
    @pointerdown.stop
  >
    <div class="px-3 py-3 border-b border-border-soft">
      <template v-if="isLoggedIn">
        <div class="text-xs text-text-muted">当前用户</div>
        <div class="mt-0.5 flex items-center justify-between gap-3">
          <div class="min-w-0 text-sm font-semibold text-text-main truncate">{{ username }}</div>
          <button
            class="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-text-muted hover:text-danger cursor-pointer"
            @click="logout"
          >
            <LogOut :size="14" />
            <span>退出登录</span>
          </button>
        </div>
      </template>
      <div v-else class="grid grid-cols-2 gap-2">
        <button
          class="h-9 rounded-lg bg-accent hover:bg-accent-hover text-white text-sm font-semibold cursor-pointer"
          @click="login"
        >
          登录
        </button>
        <button
          class="h-9 rounded-lg border border-border-soft bg-panel hover:bg-panel-soft text-sm font-semibold text-text-main cursor-pointer"
          @click="register"
        >
          注册
        </button>
      </div>
    </div>

    <button
      v-for="item in userMenuItems"
      :key="item.label"
      class="w-full px-3 py-2.5 text-left text-sm text-text-main hover:bg-accent-soft flex items-center gap-2"
      @click="handleItem(item.action)"
    >
      <component :is="item.icon" :size="16" class="text-text-muted shrink-0" />
      <span>{{ item.label }}</span>
    </button>
  </div>
</template>
