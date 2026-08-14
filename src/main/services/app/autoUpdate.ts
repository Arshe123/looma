import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { createUpdateService, type UpdateService } from './updateService'

let service: UpdateService | null = null

export const initializeAutoUpdateService = (prepareInstall: () => Promise<void>) => {
  if (service) return service

  service = createUpdateService(autoUpdater, {
    isPackaged: app.isPackaged,
    prepareInstall,
    broadcast: state => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('app:update:state', state)
      }
    },
  })
  service.initialize()
  return service
}

export const getAutoUpdateService = () => {
  if (!service) throw new Error('自动更新服务尚未初始化')
  return service
}
