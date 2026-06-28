import { ipcMain, BrowserWindow } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { workspaceService } from '../services/workspace/workspaceService';
import { createWindow } from '../index';

const getWindowFromEvent = (event: IpcMainInvokeEvent) => {
  return BrowserWindow.fromWebContents(event.sender) ?? null;
};

// Window Management IPC
ipcMain.handle('window:close', async (event) => {
  const win = getWindowFromEvent(event);
  if (win && !(win as any).isReadyToClose) {
    (win as any).isReadyToClose = true;
    win.close();
  }
});

ipcMain.handle('window:minimize', async (event) => {
  const win = getWindowFromEvent(event);
  win?.minimize();
});

ipcMain.handle('window:toggleMaximize', async (event) => {
  const win = getWindowFromEvent(event);
  if (!win) return;

  if (win.isMaximized()) {
    win.unmaximize();
    return;
  }

  win.maximize();
});

ipcMain.handle('window:openWorkspace', async (_, workspaceId: string) => {
  if (!workspaceId) return { success: false, error: 'Workspace ID is required' };
  const exists = await workspaceService.checkExists(workspaceId);
  if (!exists.success || !exists.data) return { success: false, error: exists.error || 'Workspace not found' };
  if (!exists.data.exists) {
    await workspaceService.removeWorkspace(workspaceId);
    return { success: false, error: 'Workspace has been moved or deleted' };
  }
  createWindow(workspaceId);
  return { success: true };
});

export { getWindowFromEvent };