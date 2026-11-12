import type { ListProviderModelsOptions } from './providerModels'

type DiscoveryTarget = Pick<ListProviderModelsOptions, 'protocol' | 'baseUrl'>

/** 只适配文档明确的官方端点；不把通用 /models 的未知条目猜成向量模型。 */
export function getEmbeddingDiscoveryTarget(baseUrl: string): DiscoveryTarget | null {
  let url: URL
  try { url = new URL(baseUrl) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) return null
  const path = url.pathname.replace(/\/+$/, '')
  if (url.hostname === 'api.openai.com' && path === '/v1') {
    return { protocol: 'openai-embedding', baseUrl: `${url.origin}/v1` }
  }
  if (url.hostname === 'openrouter.ai' && path === '/api/v1') {
    return { protocol: 'openrouter-embedding', baseUrl: `${url.origin}/api/v1` }
  }
  // Model-list hosts differ from inference hosts; never infer a workspace or region.
  const isDashscope = url.hostname === 'dashscope-us.aliyuncs.com'
    || /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|cn-hongkong|ap-northeast-1|eu-central-1)\.maas\.aliyuncs\.com$/.test(url.hostname)
  if (isDashscope && ['', '/api/v1', '/compatible-mode/v1'].includes(path)) {
    return { protocol: 'dashscope-embedding', baseUrl: url.origin }
  }
  return null
}
