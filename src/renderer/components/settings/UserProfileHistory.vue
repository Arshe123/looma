<script setup lang="ts">
import { ref, onUnmounted } from 'vue'
import type { createMemoryEditor } from './memoryEditor'
import { createUserProfileHistory, type UserProfileHistoryAPI } from './userProfileHistory'
import SettingsHelp from './SettingsHelp.vue'
const props = defineProps<{ editor: ReturnType<typeof createMemoryEditor>; api?: UserProfileHistoryAPI; scopeLabel?: string }>()
const history = createUserProfileHistory(props.editor, props.api ?? window.electronAPI.agentMemory)
const open = ref(false)
const sourceLabels = { manual: '手动保存前', agent: 'Agent 保存前', restore: '恢复前' }
const description = '每次画像变更前保留旧内容，含升级前已有画像；相同内容不新增版本。来源表示触发备份的操作，不代表内容作者或后续保存成功。失败的保存也可能留下有效的旧内容备份。\n\n恢复会先备份当前画像，可再次恢复撤销；不会更改已有对话快照。请先保存或丢弃未保存的编辑。历史仅保存在本机，不自动删除。'

async function toggle() {
  open.value = !open.value
  if (open.value) await history.load()
}
async function restorePrevious() {
  if (!history.previous) return
  await history.select(history.previous.id)
  history.requestRestore()
}
onUnmounted(() => history.dispose())
</script>

<template>
  <div class="space-y-3 border-t border-border-soft pt-3">
    <div class="flex items-center gap-1.5">
      <button type="button" :aria-expanded="open" aria-controls="user-profile-history" :disabled="history.busy" class="rounded px-2 py-1 text-sm disabled:opacity-50" @click="toggle">历史版本</button>
      <SettingsHelp id="user-history-description" label="历史版本" :text="description" />
    </div>
    <div v-if="open" id="user-profile-history" class="space-y-3">
      <div class="flex flex-wrap gap-3">
        <button type="button" :disabled="history.busy" class="text-sm disabled:opacity-50" @click="history.load()">刷新历史</button>
        <button type="button" :disabled="!history.previous || history.busy || editor.busy || !editor.ready" class="text-sm disabled:opacity-50" @click="restorePrevious">恢复上一版</button>
      </div>
      <p v-if="history.busy" role="status" class="text-sm text-muted">正在读取或恢复…</p>
      <p v-if="history.error" role="alert" class="text-sm text-red-500">{{ history.error }}</p>
      <p v-if="history.loaded && !history.entries.length" class="text-sm text-muted">暂无历史版本；画像变更时会保留旧内容。</p>
      <p v-if="history.loaded && history.entries.length && !history.previous" class="text-sm text-muted">已加载的历史中没有可恢复的不同版本。{{ history.nextCursor ? '可加载更早版本继续查找。' : '' }}</p>
      <p v-if="history.nextCursor" class="text-sm text-muted">“恢复上一版”仅从已加载的有效版本中选择，自动跳过损坏版本。</p>
      <ul class="max-h-48 space-y-1 overflow-auto">
        <li v-for="version in history.entries" :key="version.id">
          <button type="button" :disabled="history.busy || version.status === 'invalid'" :aria-pressed="history.selected?.id === version.id" class="w-full rounded border border-border-soft p-2 text-left text-sm disabled:opacity-50" @click="history.select(version.id)">
            {{ new Date(version.createdAt).toLocaleString() }} ·
            <template v-if="version.status === 'valid'">
              {{ sourceLabels[version.source] }} · {{ version.revision.slice(0, 8) }}
              <span v-if="version.revision === editor.revision">（与当前相同）</span>
            </template>
            <span v-else>{{ version.error }}（文件已保留）</span>
          </button>
        </li>
      </ul>
      <button v-if="history.nextCursor" type="button" :disabled="history.busy" class="text-sm disabled:opacity-50" @click="history.load(true)">加载更早版本</button>
      <div v-if="history.selected" class="space-y-2">
        <pre aria-label="历史版本完整内容" class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border-soft bg-surface p-3 text-sm">{{ history.selected.content }}</pre>
        <button type="button" :disabled="history.busy || editor.busy || !editor.ready || history.selected.revision === editor.revision" class="rounded border border-border-soft px-3 py-1.5 text-sm disabled:opacity-50" @click="history.requestRestore()">恢复此版本</button>
      </div>
      <div v-if="history.confirming" role="group" aria-label="确认恢复历史版本" class="space-y-2 rounded border border-border-soft p-3">
        <p class="text-sm">确认用所选版本替换{{ scopeLabel || '当前画像' }}？当前已保存内容会保留在历史中。</p>
        <div class="flex gap-3">
          <button type="button" class="rounded border border-border-soft px-3 py-1.5 text-sm" @click="history.restore()">确认恢复</button>
          <button type="button" class="px-3 py-1.5 text-sm" @click="history.confirming = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>
