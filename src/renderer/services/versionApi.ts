// 检查更新 / 应用版本 接口服务
// 后端：AppVersionController（GlobalRestController，继承 BaseController）
// 全局前缀 /globalApi，控制器路由 /app/version（地址统一由 apiConfig 提供）
// 该接口已加入登录白名单，无需登录即可访问。

import { buildGlobalApiUrl } from './apiConfig'

/** 后端 /app/version/latest 返回的最新版本信息 */
export type LatestVersion = {
  /** 最新版本号，如 0.12.0 */
  version: string
  /** 最低可用版本号，低于该版本需强制更新，如 0.10.0 */
  minVersion?: string | null
  /** 发布日期，yyyy-MM-dd */
  releaseDate?: string | null
  /** 更新说明 */
  notes?: string | null
  /** 下载地址 */
  downloadUrl?: string | null
  /** 后端显式标记的强制更新 */
  forceUpdate?: boolean | null
  /** 主键（后台管理用，前端一般忽略） */
  id?: string
  /** 创建时间（后台管理用，前端一般忽略） */
  createTime?: string | null
}

/** 检查更新的判定结果 */
export type UpdateCheckResult = {
  /** 是否有可用更新（当前版本 < 最新版本） */
  hasUpdate: boolean
  /** 是否需要强制更新（当前版本 < minVersion，或后端 forceUpdate=true 且有更新） */
  forceUpdate: boolean
  /** 当前应用版本 */
  currentVersion: string
  /** 最新版本信息 */
  latest: LatestVersion
}

type LoomaApiResponse<T> = {
  code: number
  message?: string
  data?: T
}

const getAppVersionBaseUrl = () => buildGlobalApiUrl('/app/version')

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
 * 语义化版本比较：a 与 b 比较。
 * 返回 -1（a < b）、0（a == b）、1（a > b）。
 * 兼容形如 0.12.0、0.10.1-beta、v0.7.3 的版本串：
 * 去掉前缀 v，忽略 - 之后的预发布标识，仅按数字段比较。
 */
export const compareVersions = (a: string, b: string): number => {
  const normalize = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('-')[0] // 丢弃 -beta/-alpha 等预发布标识
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)

  const pa = normalize(a)
  const pb = normalize(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const na = pa[i] ?? 0
    const nb = pb[i] ?? 0
    if (na > nb) return 1
    if (na < nb) return -1
  }
  return 0
}

/** 获取最新版本；库中无记录时返回 null */
export const fetchLatestVersion = async (): Promise<LatestVersion | null> => {
  const response = await fetch(`${getAppVersionBaseUrl()}/latest`, {
    method: 'GET',
    credentials: 'include',
  })
  return parseResponse<LatestVersion | null>(response, '获取最新版本失败，请稍后重试')
}

/**
 * 检查更新：拉取最新版本并与当前版本比较。
 * @param currentVersion 当前应用版本（来自 electron app.getVersion()）
 * @returns UpdateCheckResult；库中无版本记录时返回 null
 */
export const checkForUpdate = async (currentVersion: string): Promise<UpdateCheckResult | null> => {
  const latest = await fetchLatestVersion()
  if (!latest || !latest.version) return null

  const hasUpdate = compareVersions(currentVersion, latest.version) < 0
  const belowMin = Boolean(latest.minVersion) && compareVersions(currentVersion, latest.minVersion as string) < 0
  // 强制更新：低于最低版本，或后端显式标记 forceUpdate（且确实存在更新）
  const forceUpdate = belowMin || (hasUpdate && Boolean(latest.forceUpdate))

  return {
    hasUpdate,
    forceUpdate,
    currentVersion,
    latest,
  }
}
