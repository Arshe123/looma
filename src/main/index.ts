import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { fileService } from './services/fileService';
import { telemetryService } from './services/telemetryService';
import { workspaceService } from './services/workspaceService';
import { fileSystemService, fileWatchService } from './services/fileSystemService';
import { workspaceMetaService } from './services/workspaceMetaService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

const getWorkspaceById = async (workspaceId: string) => {
  const state = await workspaceService.getState();
  if (!state.success || !state.data) return null;
  return state.data.workspaces.find((w) => w.id === workspaceId) ?? null;
};

const setWindowTitleForWorkspace = async (workspaceId: string | null) => {
  const win = mainWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!win) return;
  if (!workspaceId) {
    win.setTitle('With You');
    return;
  }
  const ws = await getWorkspaceById(workspaceId);
  win.setTitle(ws?.name || 'With You');
};

const buildAppMenu = (win: BrowserWindow) => {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '切换工作空间…',
          accelerator: 'Ctrl+O',
          click: () => win.webContents.send('app:command', { id: 'workspace.switch' }),
        },
        {
          label: '新建工作空间…',
          accelerator: 'Ctrl+Shift+N',
          click: () => win.webContents.send('app:command', { id: 'workspace.new' }),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '切换开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
};

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

  mainWindow = win;
  win.setIcon(path.join(__dirname, '../public/logo.png'));

  // Handle close event to request workspace state before actually closing
  win.on('close', (e) => {
    if (!(win as any).isReadyToClose) {
      e.preventDefault();
      win.webContents.send('window:prepare-close');
    }
  });

  Menu.setApplicationMenu(buildAppMenu(win));

  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    if (initialWorkspaceId) url.searchParams.set('workspaceId', initialWorkspaceId);
    win.loadURL(url.toString());
  } else {
    const query: Record<string, string> = {};
    if (initialWorkspaceId) query.workspaceId = initialWorkspaceId;
    win.loadFile(path.join(__dirname, '../dist/index.html'), { query });
  }
  
  // Initialize telemetry and check for updates
  // TODO: Check user preference for consent before initializing telemetry.
  telemetryService.init(false); // Default to no consent for now.
  telemetryService.checkForUpdates();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    workspaceService
      .getState()
      .then(async (r) => {
        const activeId = r.success && r.data?.activeId ? r.data.activeId : undefined;
        createWindow(activeId);
        await setWindowTitleForWorkspace(activeId ?? null);
      })
      .catch(() => {
        createWindow();
      });
  });
}

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

ipcMain.handle('file:readFileBase64', async (_, filePath: string) => {
  return await fileService.readFileBase64(filePath);
});

ipcMain.handle('file:writeMarkdown', async (_, filePath: string, content: string) => {
  return await fileService.writeMarkdown(filePath, content);
});

ipcMain.handle('app:showMessageBox', async (_, options: any) => {
  if (!mainWindow) return { response: 0 };
  return await dialog.showMessageBox(mainWindow, options);
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

ipcMain.handle('workspace:checkExists', async (_, id: string) => {
  return await workspaceService.checkExists(id);
});

ipcMain.handle('workspace:recreate', async (_, id: string) => {
  return await workspaceService.recreateWorkspace(id);
});

ipcMain.handle('workspace:setActive', async (_, id: string | null) => {
  const r = await workspaceService.setActiveWorkspace(id);
  if (r.success) await setWindowTitleForWorkspace(id);
  return r;
});

ipcMain.handle('workspace:new', async (_, parentDir: string, name: string, template?: 'empty' | 'basic') => {
  try {
    const folderName = (name || '').trim();
    if (!folderName) return { success: false, error: 'Workspace name is required' };
    const parent = (parentDir || '').trim();
    if (!parent) return { success: false, error: 'Parent directory is required' };
    const dest = path.join(parent, folderName);
    await fs.mkdir(dest, { recursive: false });
    if (template === 'basic') {
      const md = [
        '# Welcome',
        '',
        '这是一个新的工作空间。',
        '',
        '- Ctrl+O：切换工作空间',
        '- Ctrl+Shift+N：新建工作空间',
        '',
      ].join('\n');
      await fs.writeFile(path.join(dest, 'Welcome.md'), md, 'utf-8');
    }
    return await workspaceService.createWorkspace(dest, folderName);
  } catch (error: any) {
    return { success: false, error: `Failed to create workspace: ${error?.message ?? String(error)}` };
  }
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
  await fileWatchService.stop(event.sender);
  return { success: true };
});

ipcMain.handle('fs:showItemInFolder', async (_, workspaceId: string, relativePath: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  const fullPath = path.join(workspacePath, relativePath);
  shell.showItemInFolder(fullPath);
  return { success: true };
});


// Window Management IPC
ipcMain.handle('window:close', async () => {
  const win = mainWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win && !(win as any).isReadyToClose) {
    (win as any).isReadyToClose = true;
    win.close();
  }
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
