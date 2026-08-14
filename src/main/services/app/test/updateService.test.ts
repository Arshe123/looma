import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createUpdateService } from '../updateService'

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowPrerelease = true
  checkForUpdates = vi.fn(async () => null)
  downloadUpdate = vi.fn(async () => [])
  quitAndInstall = vi.fn()
}

describe('update service', () => {
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
