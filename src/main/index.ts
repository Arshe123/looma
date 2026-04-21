import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { fileService } from './services/fileService';
import { telemetryService } from './services/telemetryService';
import { workspaceService } from './services/workspaceService';
import { fileSystemService, fileWatchService } from './services/fileSystemService';
import { workspaceMetaService } from './services/workspaceMetaService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createWindow(initialWorkspaceId?: string) {
  const preloadPath = process.env.VITE_DEV_SERVER_URL
    ? path.join(process.cwd(), 'dist-electron', 'preload.cjs')
    : path.join(__dirname, 'preload.cjs');

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hidden',
  });

  win.setIcon(path.join(__dirname, '../public/logo.png'));

  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    if (initialWorkspaceId) url.searchParams.set('workspaceId', initialWorkspaceId);
    win.loadURL(url.toString());
  } else {
    if (initialWorkspaceId) {
      win.loadFile(path.join(__dirname, '../dist/index.html'), { query: { workspaceId: initialWorkspaceId } });
    } else {
      win.loadFile(path.join(__dirname, '../dist/index.html'));
    }
  }
  
  // Initialize telemetry and check for updates
  // TODO: Check user preference for consent before initializing telemetry.
  telemetryService.init(false); // Default to no consent for now.
  telemetryService.checkForUpdates();
}

app.whenReady().then(() => {
  workspaceService
    .getState()
    .then((r) => createWindow(r.success && r.data?.activeId ? r.data.activeId : undefined))
    .catch(() => createWindow());
});

// 关闭所有窗口时退出应用 (Windows & Linux)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers for File Service
ipcMain.handle('file:readMarkdown', async (_, filePath: string) => {
  return await fileService.readMarkdown(filePath);
});

ipcMain.handle('file:writeMarkdown', async (_, filePath: string, content: string) => {
  return await fileService.writeMarkdown(filePath, content);
});

// Workspace Meta IPC (simplified version for now)
ipcMain.handle('workspace:selectDir', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('workspace:getState', async () => {
  return await workspaceService.getState();
});

ipcMain.handle('workspace:list', async () => {
  return await workspaceService.listWorkspaces();
});

ipcMain.handle('workspace:create', async (_, workspacePath: string, name?: string) => {
  return await workspaceService.createWorkspace(workspacePath, name);
});

ipcMain.handle('workspace:rename', async (_, id: string, newName: string) => {
  return await workspaceService.renameWorkspace(id, newName);
});

ipcMain.handle('workspace:remove', async (_, id: string) => {
  return await workspaceService.removeWorkspace(id);
});

ipcMain.handle('workspace:reorder', async (_, order: string[]) => {
  return await workspaceService.reorderWorkspaces(order);
});

ipcMain.handle('workspace:setActive', async (_, id: string) => {
  return await workspaceService.setActiveWorkspace(id);
});

ipcMain.handle('workspaceMeta:get', async (_, workspaceId: string) => {
  return await workspaceMetaService.getMeta(workspaceId);
});

ipcMain.handle('workspaceMeta:set', async (_, workspaceId: string, meta: any) => {
  return await workspaceMetaService.setMeta(workspaceId, meta);
});

const getWorkspacePathById = async (workspaceId: string) => {
  const state = await workspaceService.getState();
  if (!state.success || !state.data) return null;
  const ws = state.data.workspaces.find((w) => w.id === workspaceId);
  return ws?.path ?? null;
};

ipcMain.handle('fs:listDir', async (_, workspaceId: string, dirRelativePath: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  return await fileSystemService.listDir(workspacePath, dirRelativePath);
});

ipcMain.handle('fs:createFolder', async (_, workspaceId: string, parentDirRelativePath: string, name: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  return await fileSystemService.createFolder(workspacePath, parentDirRelativePath, name);
});

ipcMain.handle('fs:createFile', async (_, workspaceId: string, parentDirRelativePath: string, name: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  return await fileSystemService.createFile(workspacePath, parentDirRelativePath, name);
});

ipcMain.handle('fs:rename', async (_, workspaceId: string, targetRelativePath: string, newName: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  return await fileSystemService.rename(workspacePath, targetRelativePath, newName);
});

ipcMain.handle('fs:move', async (_, workspaceId: string, fromRelativePath: string, toRelativePath: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  return await fileSystemService.move(workspacePath, fromRelativePath, toRelativePath);
});

ipcMain.handle('fs:delete', async (_, workspaceId: string, targetRelativePath: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  return await fileSystemService.softDelete(workspaceId, workspacePath, targetRelativePath);
});

ipcMain.handle('fs:restore', async (_, workspaceId: string, trashRelativePath: string, restoreToRelativePath: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  return await fileSystemService.restoreFromTrash(workspaceId, workspacePath, trashRelativePath, restoreToRelativePath);
});

ipcMain.handle('fs:watchStart', async (event, workspaceId: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  fileWatchService.start(workspaceId, workspacePath, event.sender);
  return { success: true };
});

ipcMain.handle('fs:watchStop', async (event, workspaceId: string) => {
  await fileWatchService.stop(workspaceId, event.sender);
  return { success: true };
});


// Window Management IPC
ipcMain.handle('window:close', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.close();
});

ipcMain.handle('window:minimize', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.minimize();
});

ipcMain.handle('window:toggleMaximize', async () => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!win) return;

  if (win.isMaximized()) {
    win.unmaximize();
    return;
  }

  win.maximize();
});

ipcMain.handle('window:openWorkspace', async (_, workspaceId: string) => {
  createWindow(workspaceId);
  return { success: true };
});
