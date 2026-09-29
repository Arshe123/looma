import { onScopeDispose, ref, watch } from 'vue'
import { listProviderModels, type ListProviderModelsOptions, type ProviderModel } from '../services/providerModels'

/** 仅缓存当前配置的列表；密钥不参与持久化缓存，也不输出到日志。 */
export function useProviderModels(getConfig: () => ListProviderModelsOptions | null) {
  const models = ref<ProviderModel[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')
  let active: AbortController | undefined

  const invalidate = () => {
    active?.abort()
    active = undefined
    loading.value = false
  }

  const refresh = async () => {
    invalidate()
    const config = getConfig()
    if (!config) return
    const controller = new AbortController()
    active = controller
    loading.value = true
    error.value = ''
    try {
      const result = await listProviderModels({ ...config, signal: controller.signal })
      if (active !== controller) return
      models.value = result
      loaded.value = true
    } catch (cause) {
      if (active !== controller) return
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
