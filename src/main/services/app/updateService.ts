import type { UpdateState } from '../../../shared/types/app-update'

type UpdateInfo = {
  version?: string
  releaseName?: string | null
  releaseNotes?: string | Array<{ note?: string }> | null
  releaseDate?: string | null
}

type DownloadProgress = {
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}

export type UpdaterLike = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  on: (event: string, listener: (...args: any[]) => void) => unknown
  checkForUpdates: () => Promise<unknown>
  downloadUpdate: () => Promise<unknown>
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void
}

type UpdateServiceOptions = {
  isPackaged: boolean
  broadcast: (state: UpdateState) => void
  prepareInstall: () => Promise<void>
  logError?: (message: string, error: unknown) => void
}

type UpdateAction = 'check' | 'download' | 'install'

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export const getUpdateErrorMessage = (error: unknown, action: UpdateAction) => {
  const detail = errorText(error)

  if (action === 'check' && /latest\.ya?ml/i.test(detail) && /(404|cannot find|not found)/i.test(detail)) {
    return '更新服务暂时不可用，请稍后再试。'
  }

  if (/(ENOTFOUND|ETIMEDOUT|ECONNRESET|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|net::|network error|unable to resolve)/i.test(detail)) {
    return '无法连接更新服务器，请检查网络后重试。'
  }

  if (action === 'download') return '更新下载失败，请检查网络后重试。'
  if (action === 'install') return '安装更新失败，请稍后重试。'
  return '暂时无法检查更新，请稍后重试。'
}

const releaseNotesText = (notes: UpdateInfo['releaseNotes']) => {
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) return notes.map(item => item.note).filter(Boolean).join('\n') || null
  return null
}

const releaseDateText = (releaseDate: UpdateInfo['releaseDate']) => releaseDate?.slice(0, 10) || null

export const createUpdateService = (updater: UpdaterLike, options: UpdateServiceOptions) => {
  let initialized = false
  let state: UpdateState = { status: 'idle' }

  const publish = (nextState: UpdateState) => {
    state = nextState
    options.broadcast(state)
    return state
  }

  const fail = (error: unknown, action: UpdateAction) => {
    options.logError?.(`[update:${action}] ${errorText(error)}`, error)
    return publish({
      ...state,
      status: 'error',
      error: getUpdateErrorMessage(error, action),
    })
  }

  const withInfo = (status: UpdateState['status'], info: UpdateInfo): UpdateState => ({
    ...state,
    status,
    version: info.version ?? state.version,
    releaseName: info.releaseName ?? state.releaseName ?? null,
    releaseNotes: releaseNotesText(info.releaseNotes) ?? state.releaseNotes ?? null,
    releaseDate: releaseDateText(info.releaseDate) ?? state.releaseDate ?? null,
    error: undefined,
  })

  const initialize = () => {
    if (initialized) return
    initialized = true
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false

    updater.on('checking-for-update', () => publish({ status: 'checking' }))
    updater.on('update-available', (info: UpdateInfo) => publish(withInfo('available', info)))
    updater.on('update-not-available', (info: UpdateInfo) => publish(withInfo('not-available', info)))
    updater.on('download-progress', (progress: DownloadProgress) => publish({
      ...state,
      status: 'downloading',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
      error: undefined,
    }))
    updater.on('update-downloaded', (info: UpdateInfo) => publish(withInfo('downloaded', info)))
    updater.on('error', (error: unknown) => fail(error, state.status === 'downloading' ? 'download' : 'check'))
  }

  const check = async () => {
    if (!options.isPackaged) {
      return publish({ status: 'error', error: '自动更新仅支持已安装的正式版本' })
    }
    publish({ status: 'checking' })
    try {
      await updater.checkForUpdates()
    } catch (error) {
      fail(error, 'check')
    }
    return state
  }

  const download = async () => {
    if (state.status !== 'available') {
      return publish({ ...state, status: 'error', error: '当前没有可下载的更新' })
    }
    publish({ ...state, status: 'downloading', percent: 0, error: undefined })
    try {
      await updater.downloadUpdate()
    } catch (error) {
      fail(error, 'download')
    }
    return state
  }

  const install = async () => {
    if (state.status !== 'downloaded') {
      return publish({ ...state, status: 'error', error: '更新尚未下载完成' })
    }
    try {
      await options.prepareInstall()
      updater.quitAndInstall(false, true)
      return state
    } catch (error) {
      return fail(error, 'install')
    }
  }

  return {
    initialize,
    getState: () => state,
    check,
    download,
    install,
  }
}

export type UpdateService = ReturnType<typeof createUpdateService>
