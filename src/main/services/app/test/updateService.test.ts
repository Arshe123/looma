import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createUpdateService, getUpdateErrorMessage } from '../updateService'

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  checkForUpdates = vi.fn(async () => null)
  downloadUpdate = vi.fn(async () => [])
  quitAndInstall = vi.fn()
}

describe('update service', () => {
  it('turns missing release metadata and network failures into concise messages', () => {
    const longMissingMetadataError = new Error(
      'Cannot find latest.yml in the latest release artifacts: HttpError: 404 Headers: { lots: of-technical-detail }',
    )

    expect(getUpdateErrorMessage(longMissingMetadataError, 'check'))
      .toBe('更新服务暂时不可用，请稍后再试。')
    expect(getUpdateErrorMessage(new Error('net::ERR_INTERNET_DISCONNECTED'), 'check'))
      .toBe('无法连接更新服务器，请检查网络后重试。')
    expect(getUpdateErrorMessage(new Error('HttpError: 500'), 'check'))
      .toBe('暂时无法检查更新，请稍后重试。')
  })

  it('does not publish the raw updater error to the renderer', async () => {
    const updater = new FakeUpdater()
    updater.checkForUpdates.mockRejectedValueOnce(new Error(
      'Cannot find latest.yml in the latest release artifacts: HttpError: 404 with a very long stack',
    ))
    const logError = vi.fn()
    const service = createUpdateService(updater, {
      isPackaged: true,
      broadcast: vi.fn(),
      prepareInstall: vi.fn(),
      logError,
    })

    service.initialize()
    const state = await service.check()

    expect(state).toEqual({ status: 'error', error: '更新服务暂时不可用，请稍后再试。' })
    expect(logError).toHaveBeenCalledOnce()
    expect(logError.mock.calls[0][0]).toContain('Cannot find latest.yml')
  })

  it('publishes an available update and downloads it only after user action', async () => {
    const updater = new FakeUpdater()
    const states: unknown[] = []
    const service = createUpdateService(updater, {
      isPackaged: true,
      broadcast: state => states.push(state),
      prepareInstall: vi.fn(),
    })

    service.initialize()
    await service.check()
    updater.emit('update-available', {
      version: '1.4.0',
      releaseName: 'Looma 1.4.0',
      releaseNotes: '- 一键更新',
      releaseDate: '2026-08-14T12:00:00.000Z',
    })

    expect(updater.autoDownload).toBe(false)
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(service.getState()).toMatchObject({
      status: 'available',
      version: '1.4.0',
      releaseName: 'Looma 1.4.0',
      releaseNotes: '- 一键更新',
      releaseDate: '2026-08-14',
    })

    await service.download()
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    expect(states).toContainEqual(expect.objectContaining({ status: 'downloading' }))
  })

  it('deduplicates concurrent update checks', async () => {
    const updater = new FakeUpdater()
    let finishCheck: (() => void) | null = null
    updater.checkForUpdates.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishCheck = resolve
    }))
    const service = createUpdateService(updater, {
      isPackaged: true,
      broadcast: vi.fn(),
      prepareInstall: vi.fn(),
    })

    service.initialize()
    const first = service.check()
    const second = service.check()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    finishCheck?.()
    await Promise.all([first, second])
  })

  it('reports download progress and prepares the app before installing', async () => {
    const updater = new FakeUpdater()
    const prepareInstall = vi.fn(async () => {})
    const service = createUpdateService(updater, {
      isPackaged: true,
      broadcast: vi.fn(),
      prepareInstall,
    })

    service.initialize()
    updater.emit('update-available', { version: '1.4.0' })
    await service.download()
    updater.emit('download-progress', {
      percent: 42.35,
      transferred: 4235,
      total: 10000,
      bytesPerSecond: 2048,
    })
    expect(service.getState()).toMatchObject({
      status: 'downloading',
      percent: 42.35,
      transferred: 4235,
      total: 10000,
      bytesPerSecond: 2048,
    })

    updater.emit('update-downloaded', { version: '1.4.0' })
    await service.install()

    expect(prepareInstall).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('returns a clear error when run outside a packaged build', async () => {
    const updater = new FakeUpdater()
    const service = createUpdateService(updater, {
      isPackaged: false,
      broadcast: vi.fn(),
      prepareInstall: vi.fn(),
    })

    service.initialize()
    const state = await service.check()

    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(state).toMatchObject({
      status: 'error',
      error: '自动更新仅支持已安装的正式版本',
    })
  })
})
