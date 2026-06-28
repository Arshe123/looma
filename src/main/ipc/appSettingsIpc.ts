import { ipcMain, app } from 'electron'
import { createAppSettingsService, makeAppSettingsPath } from '../services/app/appSettingsService';

const appSettingsService = createAppSettingsService(makeAppSettingsPath(app.getPath('appData')));

ipcMain.handle('appSettings:get', async () => {
  return await appSettingsService.getSettings();
});

ipcMain.handle('appSettings:set', async (_, settings: any) => {
  return await appSettingsService.setSettings(settings);
});

export {
  appSettingsService
}