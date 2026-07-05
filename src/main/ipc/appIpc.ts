import { ipcMain, dialog, app, shell } from 'electron';
import { mainWindow } from '../index';
import { getWindowFromEvent } from './windowIpc';

ipcMain.handle('app:showMessageBox', async (event, options: any) => {
  const win = getWindowFromEvent(event) ?? mainWindow;
  if (!win) return { response: 0 };
  return await dialog.showMessageBox(win, options);
});

// 返回当前应用版本（读取 package.json 的 version）
ipcMain.handle('app:getVersion', () => app.getVersion());

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
