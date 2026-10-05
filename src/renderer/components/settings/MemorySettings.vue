<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { MAX_MEMORY_CHARS } from '../../../shared/types/agent-memory'
import { createMemoryEditor } from './memoryEditor'
import { useSettingsStore } from '../../stores/settings'
import SettingsHelp from './SettingsHelp.vue'
import UserProfileHistory from './UserProfileHistory.vue'
const settingsStore = useSettingsStore()
const memoryDescription = '保存在本机应用数据目录，与工作空间无关。soul.md 人格仅由你手动编辑；开启自动维护后，Agent 可依据你在对话中明确提供的长期事实与偏好，自主维护 user.md 用户画像，无需逐次确认。两者仍可在此编辑。\n\n新对话使用最新内容，已有对话及继续运行保持原快照；当前对话通过画像工具结果了解更新。若画像被其他对话更新，保存冲突会保留你的编辑，请重新读取并合并。人格和画像不能覆盖工具权限、审批或系统规则。内容会随对话发送给所选模型，请勿填写密码等敏感信息。'
const maintenanceDescription = '默认开启。关闭后仍会读取和使用已有画像，也可手动编辑，不会删除任何记忆。\n\n关闭保存成功后，正在运行的 Agent 也不能开始新的画像保存；已经开始保存的操作不会撤销。重新开启后，后续运行可自动维护；本轮原本具有更新工具时也会恢复权限。'
const entries = [
  { kind: 'soul', title: '人格', description: '定义助手的语气、表达风格与协作偏好。', editor: createMemoryEditor('soul', window.electronAPI.agentMemory) },
  { kind: 'user', title: '用户画像', description: '记录你希望助手长期了解的背景、习惯和偏好。', editor: createMemoryEditor('user', window.electronAPI.agentMemory) },
]
onMounted(() => {
  if (!settingsStore.isLoaded) void settingsStore.load()
  for (const entry of entries) void entry.editor.start()
})
onUnmounted(() => { for (const entry of entries) entry.editor.dispose() })
</script>

<template>
  <div class="space-y-6">
    <header class="flex items-center gap-1.5">
      <h2 class="text-lg font-medium">长期记忆</h2>
      <SettingsHelp id="memory-description" label="长期记忆" :text="memoryDescription" />
    </header>
    <section class="space-y-3 rounded-lg border border-border-soft bg-panel p-4">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-1.5">
          <h3 class="text-sm font-medium">自动维护用户画像</h3>
          <SettingsHelp id="memory-maintenance-description" label="自动维护用户画像" :text="maintenanceDescription" />
        </div>
        <button
          type="button"
          role="switch"
          aria-label="自动维护用户画像"
          aria-describedby="memory-maintenance-description"
          :aria-checked="settingsStore.autoMaintainUserProfile"
          :disabled="!settingsStore.isLoaded || settingsStore.memorySettingsBusy"
          class="relative h-[22px] w-10 shrink-0 rounded-full transition-colors disabled:opacity-50"
          :class="settingsStore.autoMaintainUserProfile ? 'bg-accent' : 'bg-text-subtle'"
          @click="settingsStore.setAutoMaintainUserProfile(!settingsStore.autoMaintainUserProfile)"
        >
          <span class="absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-all" :class="settingsStore.autoMaintainUserProfile ? 'left-5' : 'left-0.5'" />
        </button>
      </div>

      <p v-if="settingsStore.memorySettingsBusy" role="status" class="text-sm text-muted">正在保存设置…</p>
      <p v-if="settingsStore.lastError" role="alert" class="text-sm text-red-500">{{ settingsStore.lastError }}</p>
    </section>
    <section v-for="entry in entries" :key="entry.kind" class="space-y-3 rounded-lg border border-border-soft p-4">
      <div class="flex items-center gap-1.5">
        <label :for="`memory-${entry.kind}`" class="font-medium">{{ entry.title }}</label>
        <SettingsHelp :id="`memory-${entry.kind}-description`" :label="entry.title" :text="`${entry.description} 支持 Markdown，最多 ${MAX_MEMORY_CHARS} 字符。`" />
      </div>
      <textarea
        :id="`memory-${entry.kind}`"
        :aria-describedby="`memory-${entry.kind}-description`"
        v-model="entry.editor.content"
        :disabled="!entry.editor.ready || entry.editor.busy"
        :maxlength="MAX_MEMORY_CHARS"
        rows="9"
        class="w-full resize-y rounded border border-border-soft bg-surface p-3 font-mono text-sm disabled:opacity-50"
        spellcheck="false"
      />
      <p v-if="entry.editor.error" role="alert" class="text-sm text-red-500">{{ entry.editor.error }}</p>
      <p v-if="entry.editor.notice" role="status" class="text-sm text-muted">{{ entry.editor.notice }}</p>
      <div class="flex items-center gap-3">
        <button class="rounded border border-border-soft px-3 py-1.5 disabled:opacity-50" :disabled="!entry.editor.ready || entry.editor.busy" @click="entry.editor.save()">保存{{ entry.title }}</button>
        <button class="rounded border border-border-soft px-3 py-1.5 disabled:opacity-50" :disabled="entry.editor.busy" @click="entry.editor.load(true)">重新加载（丢弃编辑）</button>
        <span v-if="entry.editor.busy" role="status" class="text-sm text-muted">正在处理…</span>
      </div>
      <UserProfileHistory v-if="entry.kind === 'user'" :editor="entry.editor" />
    </section>
  </div>
</template>
