import { afterEach, expect, it, vi } from 'vitest'
import { listProviderModels } from '../providerModels'
import { getEmbeddingDiscoveryTarget } from '../embeddingDiscovery'

afterEach(() => { vi.unstubAllGlobals() })
const apiKey = 'fixture-key'

it('OpenAI 只展示接口返回且官方明确支持的向量模型，不猜测未知名称', async () => {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
    { id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'text-embedding-future' },
    { id: 'text-embedding-3-large' }, { id: 'text-embedding-ada-002' },
  ] })))
  vi.stubGlobal('fetch', request)
  const models = await listProviderModels({ protocol: 'openai-embedding', baseUrl: 'https://api.openai.com/v1', apiKey })
  expect(models.map(model => model.id)).toEqual(['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'])
  expect(request.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/models')
})

it('OpenRouter 使用专用向量列表接口，保留原始 ID 并去重', async () => {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
    { id: 'vendor/vector-model', name: '向量模型' }, { id: 'vendor/vector-model' },
  ] })))
  vi.stubGlobal('fetch', request)
  await expect(listProviderModels({ protocol: 'openrouter-embedding', baseUrl: 'https://openrouter.ai/api/v1', apiKey }))
    .resolves.toEqual([{ id: 'vendor/vector-model', name: '向量模型' }])
  expect(request.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/embeddings/models')
})

it.each([
  'https://workspace-123.cn-beijing.maas.aliyuncs.com',
  'https://workspace-123.ap-southeast-1.maas.aliyuncs.com',
  'https://workspace-123.cn-hongkong.maas.aliyuncs.com',
  'https://workspace-123.ap-northeast-1.maas.aliyuncs.com',
  'https://workspace-123.eu-central-1.maas.aliyuncs.com',
  'https://dashscope-us.aliyuncs.com',
])('百炼 %s 按文本向量能力查询全部分页且不跨地域', async baseUrl => {
  const request = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ output: { total: 3, models: [
      { model: 'text-embedding-v4', name: '向量模型', capabilities: ['TR'] },
      { model: 'qwen-plus', capabilities: ['TG'] },
    ] } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ output: { total: 3, models: [
      { model: 'text-embedding-v3', capabilities: ['TR'] },
    ] } })))
  vi.stubGlobal('fetch', request)
  const target = getEmbeddingDiscoveryTarget(`${baseUrl}/compatible-mode/v1`)
  expect(target).not.toBeNull()
  const models = await listProviderModels({ ...target!, apiKey })
  expect(models.map(model => model.id)).toEqual(['text-embedding-v4', 'text-embedding-v3'])
  expect(request).toHaveBeenCalledTimes(2)
  for (const [index, [url]] of request.mock.calls.entries()) {
    const parsed = new URL(url)
    expect(parsed.origin).toBe(baseUrl)
    expect(parsed.pathname).toBe('/api/v1/models')
    expect(parsed.searchParams.get('capabilities')).toBe('TR')
    expect(parsed.searchParams.get('page_no')).toBe(String(index + 1))
  }
})

it('百炼分页提前结束时报告错误，不把不完整列表当作完整结果', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ output: { total: 1, models: [] } }))))
  await expect(listProviderModels({ protocol: 'dashscope-embedding', baseUrl: 'https://dashscope-us.aliyuncs.com', apiKey }))
    .rejects.toThrow('模型列表响应格式不正确')
})
