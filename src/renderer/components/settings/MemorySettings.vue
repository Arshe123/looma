<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import { MAX_MEMORY_CHARS } from '../../../shared/types/agent-memory'
import { createMemoryEditor } from './memoryEditor'
import { useSettingsStore } from '../../stores/settings'
import { useWorkspaceStore } from '../../stores/workspace'
import { createWorkspaceMemoryEditor } from './workspaceMemoryEditor'
import SettingsHelp from './SettingsHelp.vue'
import MemoryCleanup from './MemoryCleanup.vue'
import UserProfileHistory from './UserProfileHistory.vue'
const settingsStore = useSettingsStore()
const workspaceStore = useWorkspaceStore()
const workspaceMemory = createWorkspaceMemoryEditor(window.electronAPI.workspaceMemory, window.electronAPI.agentMemory.onChanged)
watch(() => workspaceStore.activeWorkspaceId, id => { void workspaceMemory.switchWorkspace(id) }, { immediate: true })
const workspaceDescription = '仅当前工作空间的项目目标、术语和长期约定，不是全局用户画像。保存在本机应用数据目录，以稳定工作空间标识隔离，不写入笔记目录。\n\n自动维护默认开启，仅控制此工作空间；关闭后仍可读取、手动编辑、恢复历史。关闭成功后现有运行不能开始新的保存，已开始的原子保存不能撤销。切换空间保留此设置页中的未保存草稿，离开设置页不持久化草稿。不要存入大段笔记、临时进度或秘密。已有对话保持首次快照，新对话使用最新内容。'
const memoryDescription = '三层记忆均保存在本机应用数据目录：全局人格（仅手动）、全局用户画像、当前工作空间记忆。后两层各有独立的自动维护开关。没有第四层全局事实库。\n\n新对话使用最新内容，已有对话及继续运行保持原快照；当前对话通过专用工具读取最新内容。版本冲突保留编辑，请重新读取并合并。记忆不能覆盖工具权限、审批或系统规则；内容会发送给所选模型，请勿填写密码等敏感信息。'
const maintenanceDescription = '默认开启。关闭后仍会读取和使用已有画像，也可手动编辑，不会删除任何记忆。\n\n关闭保存成功后，正在运行的 Agent 也不能开始新的画像保存；已经开始保存的操作不会撤销。重新开启后，后续运行可自动维护；本轮原本具有更新工具时也会恢复权限。'
const entries = [
  { kind: 'soul', title: '人格', description: '定义助手的语气、表达风格与协作偏好。', editor: createMemoryEditor('soul', window.electronAPI.agentMemory) },
  { kind: 'user', title: '用户画像', description: '记录你希望助手长期了解的背景、习惯和偏好。', editor: createMemoryEditor('user', window.electronAPI.agentMemory) },
]
onMounted(() => {
  if (!settingsStore.isLoaded) void settingsStore.load()
  for (const entry of entries) void entry.editor.start()
})
onUnmounted(() => { for (const entry of entries) entry.editor.dispose(); workspaceMemory.dispose() })
</script>

<template>
  <div class="space-y-6">
    <header class="flex items-center gap-1.5">
      <h2 class="text-lg font-medium">长期记忆</h2>
      <SettingsHelp id="memory-description" label="长期记忆" :text="memoryDescription" />
    </header>
    <h3 class="font-medium">全局</h3>
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
    <MemoryCleanup @cleared="selection => { if (selection.user) void entries[1].editor.load(true) }" />
    <div class="flex items-center gap-1.5">
      <h3 class="font-medium">当前工作空间</h3>
      <SettingsHelp id="workspace-memory-description" label="工作空间记忆" :text="workspaceDescription" />
    </div>
    <p v-if="!workspaceStore.activeWorkspaceId" role="status" class="text-sm text-muted">尚未打开工作空间，工作空间记忆不可用。全局记忆仍可编辑。</p>
    <p v-if="workspaceMemory.loading" role="status">正在读取工作空间记忆…</p>
    <p v-if="workspaceMemory.error" role="alert" class="text-sm text-red-500">{{ workspaceMemory.error }}</p>
    <button v-if="workspaceMemory.error" type="button" @click="workspaceMemory.switchWorkspace(workspaceStore.activeWorkspaceId)">重新读取工作空间信息</button>
    <section v-if="workspaceMemory.current" :key="workspaceMemory.current.workspaceId" class="space-y-3 rounded-lg border border-border-soft p-4">
      <h4 class="font-medium">{{ workspaceMemory.current.name }} · 工作空间记忆</h4>
      <p class="text-xs text-muted">{{ workspaceMemory.current.workspaceId }}</p>
      <button type="button" role="switch" aria-label="自动维护当前工作空间记忆" :aria-checked="workspaceMemory.current.enabled" :disabled="!workspaceMemory.current.settingReady || workspaceMemory.current.settingBusy" class="rounded border border-border-soft px-3 py-1.5 disabled:opacity-50" @click="workspaceMemory.current.setEnabled(!workspaceMemory.current.enabled)">自动维护当前工作空间记忆：{{ workspaceMemory.current.enabled ? '开启' : '关闭' }}</button>
      <p v-if="workspaceMemory.current.settingError" role="alert" class="text-sm text-red-500">{{ workspaceMemory.current.settingError }}</p>
      <label for="workspace-memory-content" class="block text-sm">工作空间记忆</label>
      <textarea id="workspace-memory-content" v-model="workspaceMemory.current.editor.content" :maxlength="MAX_MEMORY_CHARS" :disabled="!workspaceMemory.current.editor.ready || workspaceMemory.current.editor.busy" rows="9" spellcheck="false" class="w-full resize-y rounded border border-border-soft bg-surface p-3 font-mono text-sm disabled:opacity-50" />
      <p v-if="workspaceMemory.current.editor.error" role="alert" class="text-sm text-red-500">{{ workspaceMemory.current.editor.error }}</p>
      <p v-if="workspaceMemory.current.editor.notice" role="status" class="text-sm text-muted">{{ workspaceMemory.current.editor.notice }}</p>
      <div class="flex gap-3">
        <button type="button" :disabled="!workspaceMemory.current.editor.ready || workspaceMemory.current.editor.busy" class="rounded border border-border-soft px-3 py-1.5 disabled:opacity-50" @click="workspaceMemory.current.editor.save()">保存工作空间记忆</button>
        <button type="button" :disabled="workspaceMemory.current.editor.busy" class="rounded border border-border-soft px-3 py-1.5 disabled:opacity-50" @click="workspaceMemory.current.editor.load(true)">重新加载（丢弃编辑）</button>
      </div>
      <UserProfileHistory :editor="workspaceMemory.current.editor" :api="workspaceMemory.current.api" scope-label="当前工作空间记忆" />
      <MemoryCleanup :api="workspaceMemory.current.api" workspace />
    </section>
  </div>
</template>
