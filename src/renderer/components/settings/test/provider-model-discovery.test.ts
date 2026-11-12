import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../AiSettings.vue', import.meta.url), 'utf8')
describe('兼容提供商模型发现设置接线', () => {
  it('提供商显示为阿里云百炼，保留 qwen 配置标识', () => {
    expect(source).toContain("{ value: 'qwen', label: '阿里云百炼' }")
    const assistant = readFileSync(new URL('../../ai/AiAssistant.vue', import.meta.url), 'utf8')
    expect(assistant).toContain("qwen: '阿里云百炼'")
    for (const path of ['../../help/help.md', '../../../../../README.md']) {
      const content = readFileSync(new URL(path, import.meta.url), 'utf8')
      expect(content).toContain('阿里云百炼')
      expect(content).not.toContain('通义千问')
    }
  })
  it('不再使用写死的模型描述和预估大小，保留接口名称与确认状态', () => {
    expect(source).not.toContain('modelMetadata')
    expect(source).not.toContain('getModelDescription')
    expect(source).not.toContain('getModelSize')
    expect(source).not.toContain('约 4.7 GB')
    expect(source).toContain('discovered.name')
    expect(source).toContain('当前配置的模型（尚未由接口确认）')
  })
  it('云端对话模型使用前端发现列表，不保留写死候选', () => {
    const catalog = source.match(/const defaultLlmModelsByProvider[\s\S]*?\n}/)?.[0] ?? ''
    for (const provider of ['deepseek', 'openai', 'qwen', 'custom']) {
      expect(catalog.includes(`${provider}: [],`), provider).toBe(true)
    }
    expect(source).toContain('useProviderModels')
    expect(source).toContain('discoveredModels.value.map')
    expect(source).toContain('if (selectedModel) names.add(selectedModel)')
  })
  it('所有远端对话共用刷新和错误展示，Ollama 保持原路径', () => {
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
  it('向量列表仅使用已确认的发现结果，无法确认时引导查阅官方文档', () => {
    const catalog = source.match(/const defaultEmbedModelsByProvider[\s\S]*?\n}/)?.[0] ?? ''
    for (const provider of ['deepseek', 'openai', 'qwen', 'custom']) {
      expect(catalog.includes(`${provider}: [],`), provider).toBe(true)
    }
    expect(source).toContain('getEmbeddingDiscoveryTarget(embedBaseUrl.value)')
    expect(source).toContain('discoveredEmbedModels.value.map')
    expect(source).toContain('@click="refreshDiscoveredEmbedModels"')
    expect(source).toContain('请查阅官方相关文档')
    expect(source).toContain('{{ embedDiscoveryError }}')
    expect(source).toContain('当前配置的模型（尚未由接口确认）')
  })
})
