// 反馈 / 报告问题 接口服务
// 后端：FeedbackController（GlobalRestController，继承 BaseController）
// 全局前缀 /globalApi，控制器路由 /feedback（地址统一由 apiConfig 提供）

import { buildGlobalApiUrl, withAuthHeaders } from './apiConfig'

export type FeedbackType = 'BUG' | 'ADVICE' | 'CONSULTATION' | 'COMPLAINT'

export type SubmitFeedbackPayload = {
  feedbackType: FeedbackType
  content: string
  /** 登录用户 id（选填）。后端也会用登录态覆盖，主要用于前端显式携带。 */
  userId?: string
}

type LoomaApiResponse<T> = {
  code: number
  message?: string
  data?: T
}

const getFeedbackBaseUrl = () => buildGlobalApiUrl('/feedback')

const parseResponse = async <T>(response: Response, fallbackMessage: string) => {
  let result: Partial<LoomaApiResponse<T>> | null = null
  try {
    result = (await response.json()) as LoomaApiResponse<T>
  } catch {
    result = null
  }

  if (!response.ok) {
    throw new Error(result?.message || `请求失败（HTTP ${response.status}）`)
  }
  if (!result || result.code !== 200) {
    throw new Error(result?.message || fallbackMessage)
  }
  return result.data as T
}

/**
 * 提交反馈 / 报告问题
 * 后端自动补充 status=PENDING、createTime，并以登录态覆盖 userId。
 * 该接口需登录，未登录后端会拦截返回错误。
 */
export const submitFeedback = async ({ feedbackType, content, userId }: SubmitFeedbackPayload) => {
  const response = await fetch(getFeedbackBaseUrl(), {
    method: 'POST',
    headers: withAuthHeaders({
      'Content-Type': 'application/json',
    }),
    credentials: 'include',
    body: JSON.stringify({
      feedbackType,
      content: content.trim(),
      ...(userId ? { userId } : {}),
    }),
  })

  await parseResponse<null>(response, '提交失败，请稍后重试')
}
