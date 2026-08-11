// 使用 GitHub Releases 检查更新，无需登录或依赖业务后端。

const LATEST_RELEASE_URL = 'https://api.github.com/repos/Arshe123/looma/releases/latest'

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

export type GitHubRelease = {
  tag_name: string
  name?: string | null
  body?: string | null
  published_at?: string | null
  html_url: string
}

const parseResponse = async (response: Response): Promise<GitHubRelease> => {
  let result: (Partial<GitHubRelease> & { message?: string }) | null = null
  try {
    result = (await response.json()) as Partial<GitHubRelease> & { message?: string }
  } catch {
    result = null
  }

  if (!response.ok) {
    throw new Error(result?.message || `请求失败（HTTP ${response.status}）`)
  }
  if (!result?.tag_name || !result.html_url) {
    throw new Error('GitHub 返回的版本信息不完整')
  }
  return result as GitHubRelease
}

export const mapGitHubRelease = (release: GitHubRelease): LatestVersion => ({
  version: release.tag_name.replace(/^v/i, ''),
  minVersion: null,
  releaseDate: release.published_at?.slice(0, 10) || null,
  notes: release.body || release.name || null,
  downloadUrl: release.html_url,
  forceUpdate: false,
})

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
  const response = await fetch(LATEST_RELEASE_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
    },
  })
  return mapGitHubRelease(await parseResponse(response))
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
