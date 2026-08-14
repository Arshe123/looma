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

  const fail = (error: unknown) => publish({
    ...state,
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
  })

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
    updater.on('error', (error: unknown) => fail(error))
  }

  const check = async () => {
    if (!options.isPackaged) return fail(new Error('自动更新仅支持已安装的正式版本'))
    publish({ status: 'checking' })
    try {
      await updater.checkForUpdates()
    } catch (error) {
      fail(error)
    }
    return state
  }

  const download = async () => {
    if (state.status !== 'available') return fail(new Error('当前没有可下载的更新'))
    publish({ ...state, status: 'downloading', percent: 0, error: undefined })
    try {
      await updater.downloadUpdate()
    } catch (error) {
      fail(error)
    }
    return state
  }

  const install = async () => {
    if (state.status !== 'downloaded') return fail(new Error('更新尚未下载完成'))
    try {
      await options.prepareInstall()
      updater.quitAndInstall(false, true)
      return state
    } catch (error) {
      return fail(error)
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
