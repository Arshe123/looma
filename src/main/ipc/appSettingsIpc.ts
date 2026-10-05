import { ipcMain, app, BrowserWindow } from 'electron'
import { createAppSettingsService, makeAppSettingsPath } from '../services/app/appSettingsService';

const appSettingsService = createAppSettingsService(makeAppSettingsPath(app.getPath('appData')));
// Invalidation only: never broadcast settings containing provider credentials.
appSettingsService.subscribe(revision => {
  for (const window of BrowserWindow.getAllWindows()) {
    try { if (!window.webContents.isDestroyed()) window.webContents.send('appSettings:changed', revision) }
    catch { /* A closing window must not prevent notification of the others. */ }
  }
})

ipcMain.handle('appSettings:get', async () => {
  return await appSettingsService.getSettings();
});

ipcMain.handle('appSettings:set', async (_, settings: any, revision?: number) => {
  return await appSettingsService.setSettings(settings, revision);
});
ipcMain.handle('appSettings:patch', async (_, patch: unknown) => appSettingsService.patchSettings(patch));

export {
  appSettingsService
}