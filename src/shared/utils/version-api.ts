// 使用 GitHub Releases 检查更新，无需登录或依赖业务后端。

const LATEST_RELEASE_URL = 'https://api.github.com/repos/Arshe123/looma/releases/latest'

export type LatestVersion = {
  version: string
  minVersion?: string | null
  releaseDate?: string | null
  notes?: string | null
  downloadUrl?: string | null
  forceUpdate?: boolean | null
  id?: string
  createTime?: string | null
}

export type UpdateCheckResult = {
  hasUpdate: boolean
  forceUpdate: boolean
  currentVersion: string
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

  if (!response.ok) throw new Error(result?.message || `请求失败（HTTP ${response.status}）`)
  if (!result?.tag_name || !result.html_url) throw new Error('GitHub 返回的版本信息不完整')
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

export const compareVersions = (a: string, b: string): number => {
  const normalize = (version: string) => version
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map(part => Number.parseInt(part, 10) || 0)

  const left = normalize(a)
  const right = normalize(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? 0
    const rightPart = right[index] ?? 0
    if (leftPart > rightPart) return 1
    if (leftPart < rightPart) return -1
  }
  return 0
}

export const fetchLatestVersion = async (): Promise<LatestVersion | null> => {
  const response = await fetch(LATEST_RELEASE_URL, {
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json' },
  })
  return mapGitHubRelease(await parseResponse(response))
}

export const checkForUpdate = async (currentVersion: string): Promise<UpdateCheckResult | null> => {
  const latest = await fetchLatestVersion()
  if (!latest?.version) return null

  const hasUpdate = compareVersions(currentVersion, latest.version) < 0
  const belowMin = Boolean(latest.minVersion)
    && compareVersions(currentVersion, latest.minVersion as string) < 0

  return {
    hasUpdate,
    forceUpdate: belowMin || (hasUpdate && Boolean(latest.forceUpdate)),
    currentVersion,
    latest,
  }
}
