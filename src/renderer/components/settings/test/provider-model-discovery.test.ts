import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../AiSettings.vue', import.meta.url), 'utf8')
describe('兼容提供商模型发现设置接线', () => {
  it('云端对话模型使用前端发现列表，不保留写死候选', () => {
    const catalog = source.match(/const defaultLlmModelsByProvider[\s\S]*?\n}/)?.[0] ?? ''
    for (const provider of ['deepseek', 'openai', 'qwen', 'custom']) {
      expect(catalog.includes(`${provider}: [],`), provider).toBe(true)
    }
    expect(source).toContain('useProviderModels')
    expect(source).toContain('discoveredModels.value.map')
    expect(source).toContain('if (selectedModel) names.add(selectedModel)')
  })
  it('所有远端对话共用刷新和错误展示，Ollama 与向量列表保持原路径', () => {
    expect(source).toContain("const supportsModelDiscovery = computed(() => aiSettings.value.chat.provider !== 'ollama')")
    expect(source).toContain('if (!supportsModelDiscovery.value || !aiSettings.value.chat.apiKey?.trim()) return null')
    expect(source).toContain('v-if="supportsModelDiscovery"')
    expect(source).toContain('@click="refreshDiscoveredModels"')
    expect(source).toContain('{{ discoveryError }}')
    expect(source).toContain('搜索模型，或输入自定义模型名')
    expect(source).toContain('window.electronAPI.ollama.listModels(')
    expect(source).toContain('defaultEmbedModelsByProvider[aiSettings.value.embedding.provider]')
    expect(source.includes("aiSettings.value.chat.provider !== 'deepseek'")).toBe(false)
  })
})
