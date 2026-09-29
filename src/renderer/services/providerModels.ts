export interface ProviderModel {
  id: string
  name: string
}

export interface ListProviderModelsOptions {
  protocol: 'openai-compatible'
  baseUrl: string
  apiKey: string
  signal?: AbortSignal
  timeoutMs?: number
}

class ModelListError extends Error {}

/** 模型发现只在客户端执行；对话后端仍接收用户选择的原始 model ID。
 * 兼容协议使用 GET {baseUrl}/models；非兼容厂商须另加协议适配，不能盲用此端点。
 */
export async function listProviderModels(options: ListProviderModelsOptions): Promise<ProviderModel[]> {
  if (options.signal?.aborted) throw new ModelListError('已取消获取模型列表。')
  if (!options.apiKey.trim()) throw new ModelListError('请先填写 API 密钥。')
  let url: URL
  try {
    url = new URL(options.baseUrl)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
  } catch {
    throw new ModelListError('服务地址格式不正确，请填写不含账号、查询参数或锚点的 HTTP(S) 地址。')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`
  const controller = new AbortController()
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, options.timeoutMs ?? 15000)
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: 'API 密钥无效，请检查后重试。',
        403: '没有读取模型列表的权限。',
        404: '未找到模型列表接口，请检查服务地址。',
        429: '获取模型列表过于频繁，请稍后重试。',
      }
      throw new ModelListError(messages[response.status] ?? `获取模型列表失败（HTTP ${response.status}），请稍后重试。`)
    }
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) {
      throw new ModelListError('模型列表响应格式不正确。')
    }
    const models = new Map<string, ProviderModel>()
    for (const entry of payload.data) {
      if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) throw new ModelListError('模型列表响应格式不正确。')
      if (!models.has(entry.id)) models.set(entry.id, {
        id: entry.id,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : entry.id,
      })
    }
    return [...models.values()]
  } catch (error) {
    if (controller.signal.aborted) throw new ModelListError(options.signal?.aborted ? '已取消获取模型列表。' : '获取模型列表超时，请重试。')
    if (error instanceof ModelListError) throw error
    if (error instanceof SyntaxError) throw new ModelListError('模型列表响应格式不正确。')
    throw new ModelListError('无法获取模型列表，请检查网络、服务地址或跨域访问设置。')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
  }
}
