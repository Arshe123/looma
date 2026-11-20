import { onScopeDispose, ref, watch } from 'vue'
import { listProviderModels, type ListProviderModelsOptions, type ProviderModel } from '../services/providerModels'

/** 仅缓存当前配置的列表；密钥不参与持久化缓存，也不输出到日志。 */
export function useProviderModels(getConfig: () => ListProviderModelsOptions | null, getScope?: () => string) {
  const models = ref<ProviderModel[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')
  let active: AbortController | undefined
  const configIdentity = () => {
    const config = getConfig()
    return [config?.protocol, config?.baseUrl, config?.apiKey, config?.timeoutMs, getScope?.()] as const
  }

  const invalidate = () => {
    active?.abort()
    active = undefined
    loading.value = false
  }

  const refresh = async () => {
    invalidate()
    const config = getConfig()
    if (!config) return
    const identity = configIdentity()
    const controller = new AbortController()
    const isCurrent = () => active === controller && configIdentity().every((value, i) => value === identity[i])
    active = controller
    loading.value = true
    error.value = ''
    try {
      const result = await listProviderModels({ ...config, signal: controller.signal })
      if (!isCurrent()) return
      models.value = result
      loaded.value = true
    } catch (cause) {
      if (!isCurrent()) return
      error.value = cause instanceof Error ? cause.message : '获取模型列表失败，请重试。'
    } finally {
      if (active === controller) {
        active = undefined
        loading.value = false
      }
    }
  }

  watch([
    () => getConfig()?.protocol,
    () => getConfig()?.baseUrl,
    () => getConfig()?.apiKey,
    () => getConfig()?.timeoutMs,
    () => getScope?.(),
  ], () => {
    invalidate()
    models.value = []
    loaded.value = false
    error.value = ''
    void refresh()
  }, { immediate: true })
  onScopeDispose(invalidate)
  return { models, loading, loaded, error, refresh }
}
