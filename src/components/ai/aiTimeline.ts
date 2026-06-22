import type { AiAssistantTimelineOutput, AiAssistantTimelineStep } from '../../store/workspace'

type OutputDraft = Omit<AiAssistantTimelineOutput, 'id' | 'type'> & { id?: string; type?: AiAssistantTimelineOutput['type'] }

type FinishStepOptions = {
  detail?: string
  outputs?: OutputDraft[]
  status?: AiAssistantTimelineStep['status']
}

export type RagTimelineLikeEvent = {
  type: 'timeline'
  step?: Partial<AiAssistantTimelineStep> & { stepId?: string; outputs?: OutputDraft[] }
  stepId?: string
  title?: string
  description?: string
  detail?: string
  status?: AiAssistantTimelineStep['status']
  outputs?: OutputDraft[]
}

export type RagProgressLikeEvent = {
  type: 'progress'
  stepId: string
  current: number
  total?: number
  message?: string
}

export type RagTimelineEventLike = RagTimelineLikeEvent | RagProgressLikeEvent

const createOutput = (stepId: string, index: number, output: OutputDraft): AiAssistantTimelineOutput => ({
  ...output,
  type: output.type || 'text',
  id: output.id || `${stepId}-output-${index + 1}`,
})

const withOutput = (stepId: string, output: OutputDraft): AiAssistantTimelineOutput =>
  createOutput(stepId, 0, output)

const createPendingStep = (
  id: string,
  title: string,
  description: string,
  startedAt: number,
): AiAssistantTimelineStep => ({
  id,
  title,
  description,
  status: 'pending',
  startedAt,
  outputs: [],
})

export const createIndexTimeline = (startedAt = Date.now()): AiAssistantTimelineStep[] => [
  createPendingStep('validate-workspace', '检查工作空间', '确认工作空间和索引目录可用', startedAt),
  createPendingStep('scan-files', '扫描文件', '查找可索引的 Markdown、文本和 PDF 文件', startedAt),
  createPendingStep('load-documents', '读取文档', '读取文件并转换为可索引文档', startedAt),
  createPendingStep('build-vectors', '构建向量', '生成向量并构建本地索引', startedAt),
  createPendingStep('persist-index', '写入索引', '把索引文件写入工作空间', startedAt),
  createPendingStep('verify-index', '验证索引', '确认索引文件已正确生成', startedAt),
]

export const startAiTimelineStep = (
  timeline: AiAssistantTimelineStep[],
  stepId: string,
  startedAt = Date.now(),
  output?: OutputDraft,
): AiAssistantTimelineStep[] => {
  let found = false
  const next = timeline.map((step) => {
    if (step.id !== stepId) return step
    found = true
    return {
      ...step,
      status: 'active' as const,
      startedAt,
      endedAt: undefined,
      outputs: output ? [...step.outputs, withOutput(stepId, output)] : step.outputs,
    }
  })
  if (found) return next
  return [
    ...next,
    {
      id: stepId,
      title: output?.title || stepId,
      description: undefined,
      status: 'active' as const,
      startedAt,
      endedAt: undefined,
      outputs: output ? [withOutput(stepId, output)] : [],
    },
  ]
}

export const finishAiTimelineStep = (
  timeline: AiAssistantTimelineStep[],
  stepId: string,
  endedAt = Date.now(),
  options: FinishStepOptions = {},
): AiAssistantTimelineStep[] => {
  let found = false
  const next = timeline.map((step) => {
    if (step.id !== stepId) return step
    found = true
    return {
      ...step,
      status: options.status || 'completed',
      detail: options.detail ?? step.detail,
      endedAt,
      outputs: options.outputs
        ? [...step.outputs, ...options.outputs.map((output, index) => createOutput(stepId, step.outputs.length + index, output))]
        : step.outputs,
    }
  })
  if (found) return next
  return [
    ...next,
    {
      id: stepId,
      title: stepId,
      description: undefined,
      detail: options.detail,
      status: options.status || 'completed',
      startedAt: endedAt,
      endedAt,
      outputs: options.outputs?.map((output, index) => createOutput(stepId, index, output)) || [],
    },
  ]
}

export const failAiTimelineStep = (
  timeline: AiAssistantTimelineStep[],
  stepId: string,
  message: string,
  endedAt = Date.now(),
  technicalDetail?: string,
): AiAssistantTimelineStep[] => finishAiTimelineStep(timeline, stepId, endedAt, {
  status: 'error',
  detail: message,
  outputs: [
    {
      type: 'error',
      title: '执行失败',
      content: message,
    },
    ...(technicalDetail && technicalDetail !== message
      ? [{
          type: 'text' as const,
          title: '技术详情',
          content: technicalDetail,
        }]
      : []),
  ],
})

export const formatAiRuntimeError = (error: unknown, fallback = 'AI 助手请求失败。') => {
  const raw = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : String(error || '')
  const normalized = raw.toLowerCase()

  if (
    normalized.includes('llama runner process has terminated')
    || normalized.includes('cudamalloc failed')
    || normalized.includes('cuda') && normalized.includes('out of memory')
    || normalized.includes('unable to allocate cuda')
  ) {
    return {
      message: '本地 AI 模型运行失败，通常是显存不足或模型占用过高导致的。请关闭其他占用显存的程序，或在 AI 设置中换用更小的模型后重试。',
      technicalDetail: raw,
    }
  }

  if (normalized.includes('failed to connect') || normalized.includes('无法连接') || normalized.includes('connection refused')) {
    return {
      message: '无法连接本地 AI 服务。请确认 Ollama/RAG 服务已经启动后重试。',
      technicalDetail: raw,
    }
  }

  return {
    message: raw || fallback,
    technicalDetail: raw,
  }
}

const getTimelineEventStepId = (event: RagTimelineLikeEvent) => event.stepId || event.step?.stepId || event.step?.id

const upsertTimelineStep = (
  timeline: AiAssistantTimelineStep[],
  stepId: string,
  now: number,
  patch: Omit<Partial<AiAssistantTimelineStep>, 'outputs'> & { outputs?: OutputDraft[] },
): AiAssistantTimelineStep[] => {
  let found = false
  const next = timeline.map((step) => {
    if (step.id !== stepId) return step
    found = true
    const status = patch.status || step.status
    return {
      ...step,
      title: patch.title || step.title,
      description: patch.description ?? step.description,
      detail: patch.detail ?? step.detail,
      status,
      startedAt: step.status === 'pending' && status === 'active' ? now : (patch.startedAt ?? step.startedAt),
      endedAt: status === 'completed' || status === 'error' ? (patch.endedAt ?? now) : patch.endedAt ?? step.endedAt,
      outputs: patch.outputs
        ? [...step.outputs, ...patch.outputs.map((output, index) => createOutput(stepId, step.outputs.length + index, output))]
        : step.outputs,
    }
  })
  if (found) return next
  return [
    ...next,
    {
      id: stepId,
      title: patch.title || stepId,
      description: patch.description,
      detail: patch.detail,
      status: patch.status || 'pending',
      startedAt: patch.startedAt ?? now,
      endedAt: patch.status === 'completed' || patch.status === 'error' ? (patch.endedAt ?? now) : patch.endedAt,
      outputs: patch.outputs?.map((output, index) => createOutput(stepId, index, output)) || [],
    },
  ]
}

const applyProgressEvent = (
  timeline: AiAssistantTimelineStep[],
  event: RagProgressLikeEvent,
  now: number,
): AiAssistantTimelineStep[] => {
  const value = event.total !== undefined ? `${event.current}/${event.total}` : String(event.current)
  const detail = event.message
    ? `${event.message}${event.total !== undefined ? `（${value}）` : ''}`
    : `正在处理${event.total !== undefined ? ` ${value}` : ` ${event.current}`}`
  let found = false
  const next = timeline.map((step) => {
    if (step.id !== event.stepId) return step
    found = true
    const outputs = step.outputs.filter((output) => output.id !== `${event.stepId}-progress`)
    return {
      ...step,
      status: 'active' as const,
      startedAt: step.status === 'pending' ? now : step.startedAt,
      endedAt: undefined,
      detail,
      outputs: [
        ...outputs,
        {
          id: `${event.stepId}-progress`,
          type: 'metric' as const,
          title: '进度',
          value,
        },
      ],
    }
  })
  if (found) return next
  return [
    ...next,
    {
      id: event.stepId,
      title: event.stepId,
      description: undefined,
      status: 'active' as const,
      startedAt: now,
      endedAt: undefined,
      detail,
      outputs: [
        {
          id: `${event.stepId}-progress`,
          type: 'metric' as const,
          title: '进度',
          value,
        },
      ],
    },
  ]
}

export const applyRagTimelineEvent = (
  timeline: AiAssistantTimelineStep[],
  event: RagTimelineEventLike,
  now = Date.now(),
): AiAssistantTimelineStep[] => {
  if (event.type === 'progress') return applyProgressEvent(timeline, event, now)
  const stepId = getTimelineEventStepId(event)
  if (!stepId) return timeline
  return upsertTimelineStep(timeline, stepId, now, {
    title: event.title ?? event.step?.title,
    description: event.description ?? event.step?.description,
    detail: event.detail ?? event.step?.detail,
    status: event.status ?? event.step?.status,
    startedAt: event.step?.startedAt,
    endedAt: event.step?.endedAt,
    outputs: event.outputs ?? event.step?.outputs,
  })
}

export const getAiTimelineStepDuration = (step: AiAssistantTimelineStep) => {
  const end = step.endedAt || Date.now()
  const duration = Math.max(0, end - step.startedAt)
  if (duration < 1000) return `${duration}ms`
  return `${(duration / 1000).toFixed(1)}s`
}
