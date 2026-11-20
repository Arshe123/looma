import type { ListProviderModelsOptions } from './providerModels'
import { getEmbeddingDiscoveryTarget } from './embeddingDiscovery'

type ChatDiscoveryTarget = Pick<ListProviderModelsOptions, 'protocol' | 'baseUrl'>

export function getChatModelDiscoveryTarget(baseUrl: string): ChatDiscoveryTarget {
  const fallback: ChatDiscoveryTarget = { protocol: 'openai-compatible', baseUrl }
  let url: URL
  try { url = new URL(baseUrl) } catch { return fallback }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) return fallback
  const path = url.pathname.replace(/\/+$/, '')
  if (url.hostname === 'api.deepseek.com' && ['', '/v1'].includes(path)) {
    return { protocol: 'openai-compatible', baseUrl: url.origin }
  }
  // The native catalog host table is the same for both capability filters.
  const native = getEmbeddingDiscoveryTarget(baseUrl)
  if (native?.protocol === 'dashscope-embedding') return { protocol: 'dashscope-chat', baseUrl: native.baseUrl }
  return fallback
}
