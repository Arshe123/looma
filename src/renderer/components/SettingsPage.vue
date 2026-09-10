<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Code2, Cpu, Palette } from 'lucide-vue-next'
import { useWorkspaceStore, type SettingsSectionId } from '../stores/workspace'
import AiSettings from './settings/AiSettings.vue'
import AppearanceSettings from './settings/AppearanceSettings.vue'
import EditorSettings from './settings/EditorSettings.vue'
import SettingsSectionNav from './settings/SettingsSectionNav.vue'

const workspaceStore = useWorkspaceStore()
const activeSection = ref<SettingsSectionId>(workspaceStore.activeSettingsSection)

const settingSections = [
  {
    id: 'appearance',
    title: '主题',
    description: '选择主题配色与日间、夜间模式。',
    icon: Palette,
  },
  {
    id: 'editor',
    title: '编辑器',
    description: '配置 Markdown 编辑器的快速插入菜单与快捷键。',
    icon: Code2,
  },
  {
    id: 'ai',
    title: 'AI 设置',
    description: '配置本机 Ollama 模型与嵌入模型。',
    icon: Cpu,
  },
] as const

const currentSection = computed(() => {
  return settingSections.find((section) => section.id === activeSection.value) ?? settingSections[0]
})

const isEditorSection = computed(() => currentSection.value.id === 'editor')
const isAiSection = computed(() => currentSection.value.id === 'ai')
const isAppearanceSection = computed(() => currentSection.value.id === 'appearance')

watch(() => workspaceStore.activeSettingsSection, (section) => {
  activeSection.value = section
})

watch(activeSection, (section) => {
  workspaceStore.activeSettingsSection = section
})
</script>

<template>
  <main class="flex-1 overflow-hidden bg-surface">
    <div class="mx-auto flex h-full w-full max-w-6xl flex-col px-5 py-6 md:px-8">
      <div class="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <SettingsSectionNav
          v-model:active-section="activeSection"
          :sections="settingSections"
        />

        <section
          class="flex min-h-0 flex-1 flex-col rounded-lg border border-border-soft bg-panel"
          data-testid="settings-section-content"
        >
          <div
            class="min-h-0 flex-1 overflow-auto p-5"
            data-testid="settings-section-scroll-body"
          >
            <AppearanceSettings v-if="isAppearanceSection" />
            <EditorSettings v-else-if="isEditorSection" />
            <AiSettings v-else-if="isAiSection" />
          </div>
        </section>
      </div>
    </div>
  </main>
</template>
