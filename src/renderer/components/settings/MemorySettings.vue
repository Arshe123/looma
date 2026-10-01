<script setup lang="ts">
import { onMounted } from 'vue'
import { MAX_MEMORY_CHARS } from '../../../shared/types/agent-memory'
import { createMemoryEditor } from './memoryEditor'
const entries = [
  { kind: 'soul', title: '人格', description: '定义助手的语气、表达风格与协作偏好。', editor: createMemoryEditor('soul', window.electronAPI.agentMemory) },
  { kind: 'user', title: '用户画像', description: '记录你希望助手长期了解的背景、习惯和偏好。', editor: createMemoryEditor('user', window.electronAPI.agentMemory) },
]
onMounted(() => { for (const entry of entries) void entry.editor.load() })
</script>

<template>
  <div class="space-y-6">
    <header>
      <h2 class="text-lg font-medium">长期记忆</h2>
      <p class="mt-2 text-sm text-muted">保存在本机应用数据目录的 soul.md / user.md，与工作空间无关。仅由你手动编辑，不会自动学习或改写。</p>
      <p class="mt-2 text-sm text-muted">保存后仅新对话使用新内容，已有对话及继续运行保持原快照。人格和画像不能覆盖工具权限、审批或系统规则。内容会随对话发送给所选模型，请勿填写密码等敏感信息。</p>
    </header>
    <section v-for="entry in entries" :key="entry.kind" class="space-y-3 rounded-lg border border-border-soft p-4">
      <label :for="`memory-${entry.kind}`" class="block font-medium">{{ entry.title }}</label>
      <p class="text-sm text-muted">{{ entry.description }} 支持 Markdown，最多 {{ MAX_MEMORY_CHARS }} 字符。</p>
      <textarea
        :id="`memory-${entry.kind}`"
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
        <button class="rounded border border-border-soft px-3 py-1.5 disabled:opacity-50" :disabled="entry.editor.busy" @click="entry.editor.load()">重新加载（丢弃编辑）</button>
        <span v-if="entry.editor.busy" role="status" class="text-sm text-muted">正在处理…</span>
      </div>
    </section>
  </div>
</template>
