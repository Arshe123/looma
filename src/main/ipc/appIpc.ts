import { ipcMain, dialog } from 'electron';
import { mainWindow } from '../index';
import { getWindowFromEvent } from './windowIpc';

ipcMain.handle('app:showMessageBox', async (event, options: any) => {
  const win = getWindowFromEvent(event) ?? mainWindow;
  if (!win) return { response: 0 };
  return await dialog.showMessageBox(win, options);
});