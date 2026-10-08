<script setup lang="ts">
import { onUnmounted } from 'vue'
import type { MemoryCleanupSelection } from '../../../shared/types/agent-memory'
import SettingsHelp from './SettingsHelp.vue'
import { createMemoryCleanup, type MemoryCleanupAPI } from './memoryCleanup'
const props = defineProps<{ api?: MemoryCleanupAPI; workspace?: boolean }>()
const emit = defineEmits<{ cleared: [selection: MemoryCleanupSelection] }>()
const state = createMemoryCleanup(props.api ?? window.electronAPI.agentMemory, selection => emit('cleared', selection))
const help = '只清理本机应用管理的 user.md、画像历史版本和对话记忆快照。可单独选择历史或快照；清除当前画像必须同时清除两者。清理不会备份被删除内容，不能撤销。人格 soul.md 和未识别文件不会删除。\n\n待处理记忆回执也会删除，防止稍后恢复被清理的更新详情；已写入工作空间账本的更新详情、旧聊天原文、外部备份及模型服务商留存不在此范围。旧聊天可能再次提供已清理的信息，请新建对话。删除不是磁盘安全擦除，不代表彻底遗忘。\n\n请先停止所有 Agent 运行。自动维护开关不会改变；如不希望后续再次记录，请自行关闭上方开关。预览变化须重新确认，中断清理会在下次访问时继续。'
onUnmounted(state.dispose)
</script>

<template>
  <section class="space-y-3 rounded-lg border border-border-soft p-4">
    <div class="flex items-center gap-1.5">
      <h3 class="text-sm font-medium">{{ workspace ? '仅清理当前工作空间记忆' : '本机用户记忆清理' }}</h3>
      <SettingsHelp :id="workspace ? 'workspace-cleanup-help' : 'memory-cleanup-help'" label="本机记忆清理" :text="workspace ? '只删除当前工作空间的记忆、历史、工作空间层对话快照及待处理回执，不删除全局人格、用户画像或其他工作空间。清除当前记忆须同时清理历史和快照。须停止所有 Agent；删除不可撤销，也不是安全擦除。聊天、已入账详情、外部备份与服务商记录保留；开关不变。' : help" />
    </div>
    <div class="flex flex-wrap gap-4 text-sm">
      <label class="flex items-center gap-2"><input type="checkbox" :checked="state.selection.history" :disabled="state.busy || state.selection.user" @change="state.selection.history = ($event.target as HTMLInputElement).checked">{{ workspace ? '工作空间记忆历史版本' : '画像历史版本' }}</label>
      <label class="flex items-center gap-2"><input type="checkbox" :checked="state.selection.snapshots" :disabled="state.busy || state.selection.user" @change="state.selection.snapshots = ($event.target as HTMLInputElement).checked">对话记忆快照</label>
      <label class="flex items-center gap-2"><input type="checkbox" :checked="state.selection.user" :disabled="state.busy" @change="state.selection.user = ($event.target as HTMLInputElement).checked">{{ workspace ? '清除当前工作空间记忆（含历史和快照）' : '清除本机用户记忆（含当前画像）' }}</label>
    </div>
    <button type="button" class="rounded border border-border-soft px-3 py-1.5 text-sm disabled:opacity-50" :disabled="state.busy || (!state.selection.history && !state.selection.snapshots)" @click="state.inspect()">预览清理范围</button>
    <div v-if="state.preview" class="space-y-3 rounded border border-border-soft p-3 text-sm">
      <p>历史版本 {{ state.preview.counts.history }} · 对话快照 {{ state.preview.counts.snapshots }} · {{ workspace ? '工作空间记忆' : '当前画像' }} {{ state.preview.counts.user }} · 待处理回执 {{ state.preview.counts.receipts }}</p>
      <p class="text-muted">以上为文件数量，包含应用命名规则内的崩溃残留临时文件；请核对下方逐项清单。</p>
      <details>
        <summary class="cursor-pointer">查看本机管理记录清单</summary>
        <ul class="mt-2 max-h-40 overflow-auto break-all font-mono text-xs"><li v-for="record in state.preview.records" :key="record">{{ record }}</li></ul>
      </details>
      <p v-if="state.preview.skipped.length">未识别文件将保留：{{ state.preview.skipped.join('、') }}</p>
      <p class="text-muted">不删除人格、旧聊天、已入账更新详情、外部备份或服务商记录。旧聊天可能重新引入信息，请新建对话。自动维护开关不变。</p>
      <label class="flex items-start gap-2"><input type="checkbox" aria-label="确认清理范围" :checked="state.confirmed" :disabled="state.busy" @change="state.confirmed = ($event.target as HTMLInputElement).checked"><span>我已核对清单，确认不可撤销地删除以上本机记录{{ state.preview.selection.user ? '，并丢弃当前窗口的画像编辑' : '' }}。</span></label>
      <button type="button" class="rounded border border-red-500 px-3 py-1.5 text-red-500 disabled:opacity-50" :disabled="state.busy || !state.confirmed" @click="state.apply()">确认清理</button>
    </div>
    <p v-if="state.busy" role="status" class="text-sm text-muted">正在处理…</p>
    <p v-if="state.error" role="alert" class="text-sm text-red-500">{{ state.error }}</p>
    <p v-if="state.notice" role="status" class="text-sm text-muted">{{ state.notice }}</p>
  </section>
</template>
