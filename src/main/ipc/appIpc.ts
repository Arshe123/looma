import { ipcMain, dialog, app, shell } from 'electron';
import { mainWindow } from '../index';
import { getWindowFromEvent } from './windowIpc';
import { getAutoUpdateService } from '../services/app/autoUpdate';
import { manualUpdateService } from '../services/app/manualUpdate';
import { shouldAutoCheckUpdates, shouldUseManualUpdate } from '../../shared/utils/update-policy';
import { createStartupUpdateCheck } from '../services/app/startupUpdateCheck';

const getUpdateState = () => shouldUseManualUpdate(process.platform)
  ? manualUpdateService.getState()
  : getAutoUpdateService().getState();

const checkForAppUpdate = () => shouldUseManualUpdate(process.platform)
  ? manualUpdateService.check()
  : getAutoUpdateService().check();

const runStartupUpdateCheck = createStartupUpdateCheck({
  enabled: () => shouldAutoCheckUpdates(process.platform, app.isPackaged),
  getState: getUpdateState,
  check: checkForAppUpdate,
});

ipcMain.handle('app:showMessageBox', async (event, options: any) => {
  const win = getWindowFromEvent(event) ?? mainWindow;
  if (!win) return { response: 0 };
  return await dialog.showMessageBox(win, options);
});

// 返回当前应用版本（读取 package.json 的 version）
ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('app:update:getState', getUpdateState);

ipcMain.handle('app:update:check', async () => {
  const state = await checkForAppUpdate();
  return { success: state.status !== 'error', state };
});

ipcMain.handle('app:update:startupCheck', runStartupUpdateCheck);

ipcMain.handle('app:update:download', async () => {
  const state = await getAutoUpdateService().download();
  return { success: state.status !== 'error', state };
});

ipcMain.handle('app:update:install', async () => {
  const state = await getAutoUpdateService().install();
  return { success: state.status !== 'error', state };
});

// 用系统默认浏览器打开外部链接（如更新下载地址）
ipcMain.handle('app:openExternal', async (_event, url: string) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { success: false, error: '无效的链接' };
  }
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});
