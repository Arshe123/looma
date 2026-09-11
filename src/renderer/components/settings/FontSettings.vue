<script setup lang="ts">
import { ref } from 'vue'
import { useSettingsStore } from '@/renderer/stores/settings'
import { DEFAULT_FONT_PRESET, FONT_PRESETS, type FontPreset } from '@/shared/utils/font-presets'

const settingsStore = useSettingsStore()
const errorMessage = ref('')
const saving = ref(false)

const selectPreset = async (preset: FontPreset) => {
  if (saving.value) return
  saving.value = true
  errorMessage.value = ''
  settingsStore.lastError = ''
  try {
    await settingsStore.setFontPreset(preset)
    if (settingsStore.lastError) errorMessage.value = '字体搭配保存失败，请重试。'
  } catch {
    errorMessage.value = '字体搭配保存失败，请重试。'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="space-y-3 border-t border-border-soft pt-6" aria-label="字体搭配">
    <h3 class="text-sm font-medium">字体搭配</h3>
    <p class="text-xs text-text-muted">三套搭配均使用思源黑体作为界面字体、JetBrains Mono 作为代码字体，仅正文字体不同。</p>
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <button
        v-for="preset in FONT_PRESETS"
        :key="preset.id"
        type="button"
        :aria-label="preset.label"
        :aria-pressed="settingsStore.fontPreset === preset.id"
        :disabled="saving || !settingsStore.isLoaded"
        class="min-w-0 cursor-pointer rounded-lg border p-3 text-left transition-colors disabled:cursor-wait"
        :class="settingsStore.fontPreset === preset.id ? 'border-accent bg-accent-soft' : 'border-border-soft hover:bg-panel-soft'"
        @click="selectPreset(preset.id)"
      >
        <span class="font-preset-sample" :data-font-preset="preset.id">把日常，慢慢写成生活。<br><span class="text-sm">Write a little, every day.</span></span>
        <span class="mt-3 block text-sm font-medium">{{ preset.label }}{{ settingsStore.fontPreset === preset.id ? ' · 已选择' : '' }}</span>
        <span class="mt-1 block text-xs text-text-muted">正文 · {{ preset.bodyFont }}</span>
        <span class="mt-2 block text-xs text-text-muted">{{ preset.description }}</span>
      </button>
    </div>
    <p class="text-xs text-text-muted">字体已内置，离线可用。适用于笔记预览、引用预览、帮助文档及 AI 回答正文；不会修改笔记内容或字号。无需安装字体，不支持单独更换搭配内的字体。</p>
    <button type="button" :disabled="saving || !settingsStore.isLoaded" class="cursor-pointer rounded-md border border-border-soft px-3 py-2 text-sm hover:bg-panel-soft disabled:cursor-wait" @click="selectPreset(DEFAULT_FONT_PRESET)">恢复默认字体</button>
    <p class="text-xs text-text-muted">默认使用柔和手写；文楷的强调文字使用中等字重。</p>
    <p v-if="errorMessage" role="alert" class="text-xs text-danger">{{ errorMessage }}</p>
  </section>
</template>

<style scoped>
.font-preset-sample {
  display: block;
  padding: 12px 8px;
  border-radius: 6px;
  background: var(--surface);
  color: var(--text-main);
  font-family: var(--font-body);
  font-size: 17px;
  line-height: 1.8;
}
</style>
