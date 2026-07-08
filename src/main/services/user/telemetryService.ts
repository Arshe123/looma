type TelemetryInitOptions = {
  hasConsent?: boolean
}

export type LlmUsageTelemetryPayload = {
  llmModel: string
  inputTokens?: number
  outputTokens?: number
}

export type VectorRetrievalTelemetryPayload = {
  embeddingModel: string
}

export type VectorBuildConfigTelemetryPayload = {
  embeddingModel: string
  buildType: string
  chunkSize: number
  overlapSize: number
}

type GenericTelemetryPayload = Record<string, unknown>

type LoomaApiResponse<T = unknown> = {
  code?: number
  message?: string
  data?: T
}

const DEFAULT_API_HOST = 'http://localhost:8080'
const GLOBAL_API_PREFIX = '/globalApi'

let telemetryEnabled = true

const getApiHost = () => (
  process.env.VITE_API_BASE_URL
  || process.env.LOOMA_API_BASE_URL
  || process.env.API_BASE_URL
  || DEFAULT_API_HOST
).replace(/\/+$/, '')

const buildTelemetryUrl = (path: string) => `${getApiHost()}${GLOBAL_API_PREFIX}/telemetry${path}`

const postSilently = async (path: string, payload: GenericTelemetryPayload) => {
  if (!telemetryEnabled) return
  try {
    const response = await fetch(buildTelemetryUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    // 尽量消费响应，避免未读取 body；无论成功失败都不影响用户体验。
    await response.json().catch(() => null) as LoomaApiResponse | null
  } catch {
    // 遥测失败直接丢弃，不能弹窗、不能抛错、不能打断 AI/RAG 流程。
  }
}

const normalizeCount = (value: unknown) => {
  const numberValue = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.round(numberValue) : 0
}

export const telemetryService = {
  /**
   * Initialize telemetry. 当前 AI/RAG 模型使用统计不绑定用户，也不要求登录。
   * 保留 hasConsent 参数用于兼容旧调用；显式传 false 时禁用本进程遥测。
   */
  async init(optionsOrConsent: TelemetryInitOptions | boolean = true) {
    telemetryEnabled = typeof optionsOrConsent === 'boolean'
      ? optionsOrConsent
      : optionsOrConsent.hasConsent !== false
  },

  /**
   * 通用事件入口保留给旧代码兼容；当前只实现下方 AI/RAG 模型使用聚合接口。
   */
  trackEvent(_eventName: string, _properties: GenericTelemetryPayload = {}) {
    return undefined
  },

  async trackLlmUsage(payload: LlmUsageTelemetryPayload) {
    const llmModel = payload.llmModel?.trim()
    if (!llmModel) return
    await postSilently('/llm-usage', {
      llmModel,
      inputTokens: normalizeCount(payload.inputTokens),
      outputTokens: normalizeCount(payload.outputTokens),
    })
  },

  async trackVectorRetrieval(payload: VectorRetrievalTelemetryPayload) {
    const embeddingModel = payload.embeddingModel?.trim()
    if (!embeddingModel) return
    await postSilently('/vector-retrieval', { embeddingModel })
  },

  async trackVectorBuildConfig(payload: VectorBuildConfigTelemetryPayload) {
    const embeddingModel = payload.embeddingModel?.trim()
    const buildType = payload.buildType?.trim()
    if (!embeddingModel || !buildType) return
    await postSilently('/vector-build-config', {
      embeddingModel,
      buildType,
      chunkSize: normalizeCount(payload.chunkSize),
      overlapSize: normalizeCount(payload.overlapSize),
    })
  },
}
