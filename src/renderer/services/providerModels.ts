export interface ProviderModel {
  id: string
  name: string
}

export interface ListProviderModelsOptions {
  protocol: 'openai-compatible' | 'openai-embedding' | 'openrouter-embedding' | 'dashscope-embedding'
  baseUrl: string
  apiKey: string
  signal?: AbortSignal
  timeoutMs?: number
}

class ModelListError extends Error {}

// /models has no capability field; only these documented OpenAI IDs are confirmed.
const openaiEmbeddingModels = new Set(['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'])

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
  const isDashscope = options.protocol === 'dashscope-embedding'
  url.pathname = isDashscope
    ? '/api/v1/models'
    : `${url.pathname.replace(/\/+$/, '')}/${options.protocol === 'openrouter-embedding' ? 'embeddings/models' : 'models'}`
  if (isDashscope) {
    url.searchParams.set('capabilities', 'TR')
    url.searchParams.set('page_size', '100')
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  options.signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, options.timeoutMs ?? 15000)
  try {
    const models = new Map<string, ProviderModel>()
    let received = 0
    for (let page = 1; page <= 100; page++) {
      if (isDashscope) url.searchParams.set('page_no', String(page))
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
      if (!payload || typeof payload !== 'object') throw new ModelListError('模型列表响应格式不正确。')
      const output = 'output' in payload && payload.output && typeof payload.output === 'object' ? payload.output : null
      const entries = isDashscope
        ? output && 'models' in output ? output.models : undefined
        : 'data' in payload ? payload.data : undefined
      const total = output && 'total' in output ? output.total : undefined
      if (!Array.isArray(entries) || (isDashscope && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0))) {
        throw new ModelListError('模型列表响应格式不正确。')
      }
      for (const entry of entries) {
        const id = isDashscope ? entry?.model : entry?.id
        if (typeof id !== 'string' || !id.trim()) throw new ModelListError('模型列表响应格式不正确。')
        if (options.protocol === 'openai-embedding' && !openaiEmbeddingModels.has(id)) continue
        if (isDashscope && (!Array.isArray(entry.capabilities) || !entry.capabilities.includes('TR'))) continue
        if (!models.has(id)) models.set(id, {
          id,
          name: typeof entry.name === 'string' && entry.name.trim() ? entry.name : id,
        })
      }
      received += entries.length
      if (!isDashscope || received >= (total as number)) return [...models.values()]
      if (!entries.length) throw new ModelListError('模型列表响应格式不正确。')
    }
    throw new ModelListError('模型列表分页过多，请查阅官方相关文档并手动填写模型名称。')
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
