import { app, BrowserWindow, ipcMain, dialog, Menu, shell, screen } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { fileService } from './file/fileService';
import { telemetryService } from './user/telemetryService';
import { workspaceService } from './workspace/workspaceService';
import { fileSystemService, fileWatchService } from './file/fileSystemService';
import { workspaceAiService } from './workspace/workspaceAiService';
import { workspaceMetaService } from './workspace/workspaceMetaService';
import { createAppSettingsService, makeAppSettingsPath } from './app/appSettingsService';
import { ragService, type RagAiSettings } from './rag/ragService';
import { normalizeOllamaBaseUrl, ollamaService } from './ollama/ollamaService';

app.setAppUserModelId('com.looma')
app.setName('looma');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
const appSettingsService = createAppSettingsService(makeAppSettingsPath(app.getPath('appData')));
const activeRagStreams = new Map<string, AbortController>();

const normalizeVectorStorePath = (value: string) => {
  return (value || '').trim() || '.looma/rag-index';
};

const getRagAiSettings = async (): Promise<RagAiSettings> => {
  const result = await appSettingsService.getSettings();
  const ai = result.success && result.data ? result.data.ai : undefined;
  return {
    ollamaBaseUrl: normalizeOllamaBaseUrl(ai?.ollamaBaseUrl ?? ''),
    llmModel: ai?.llmModel || 'qwen2.5:7b',
    embedModel: ai?.embedModel || 'bge-m3:latest',
    vectorStorePath: normalizeVectorStorePath(ai?.vectorStorePath ?? ''),
  };
};

const getWindowFromEvent = (event: IpcMainInvokeEvent) => {
  return BrowserWindow.fromWebContents(event.sender) ?? null;
};

const getWorkspaceById = async (workspaceId: string) => {
  const state = await workspaceService.getState();
  if (!state.success || !state.data) return null;
  return state.data.workspaces.find((w) => w.id === workspaceId) ?? null;
};

const setWindowTitleForWorkspace = async (workspaceId: string | null, targetWindow?: BrowserWindow | null) => {
  const win = targetWindow ?? mainWindow ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (!win) return;
  if (!workspaceId) {
    win.setTitle('looma');
    return;
  }
  const ws = await getWorkspaceById(workspaceId);
  win.setTitle(ws?.name || 'looma');
};

const buildAppMenu = (win: BrowserWindow) => {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开工作空间（新窗口）…',
          accelerator: 'Ctrl+O',
          click: () => win.webContents.send('app:command', { id: 'workspace.switch' }),
        },
        {
          label: '新建工作空间（新窗口）…',
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
  const defaultWidth = 1200;
  const defaultHeight = 800;

  const getWindowPosition = (width: number, height: number) => {
    const referenceWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const display = referenceWindow
      ? screen.getDisplayMatching(referenceWindow.getBounds())
      : screen.getPrimaryDisplay();
    const workArea = display.workArea;

    const centeredX = Math.round(workArea.x + (workArea.width - width) / 2);
    const centeredY = Math.round(workArea.y + (workArea.height - height) / 2);

    const openedWindowCount = BrowserWindow.getAllWindows().length;
    if (openedWindowCount === 0) {
      return { x: centeredX, y: centeredY };
    }

    const stepX = 36;
    const stepY = 28;
    const maxStepsX = Math.max(1, Math.floor(Math.max(0, workArea.width - width) / stepX));
    const maxStepsY = Math.max(1, Math.floor(Math.max(0, workArea.height - height) / stepY));
    const maxSteps = Math.max(1, Math.min(maxStepsX, maxStepsY));
    const offsetStep = ((openedWindowCount - 1) % maxSteps) + 1;

    const maxX = workArea.x + Math.max(0, workArea.width - width);
    const maxY = workArea.y + Math.max(0, workArea.height - height);
    const rawX = centeredX + offsetStep * stepX;
    const rawY = centeredY + offsetStep * stepY;

    return {
      x: Math.min(Math.max(rawX, workArea.x), maxX),
      y: Math.min(Math.max(rawY, workArea.y), maxY),
    };
  };

  const position = getWindowPosition(defaultWidth, defaultHeight);
  const preloadPath = process.env.VITE_DEV_SERVER_URL
    ? path.join(process.cwd(), 'dist-electron', 'preload.cjs')
    : path.join(__dirname, 'preload.cjs');

  const win = new BrowserWindow({
    width: defaultWidth,
    height: defaultHeight,
    x: position.x,
    y: position.y,
    frame: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hidden',
  });

  mainWindow = win;
  win.setIcon(path.join(__dirname, '../public/looma.png'));

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = BrowserWindow.getAllWindows()[0] ?? null;
    }
  });

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

let isQuitting = false;

app.on('before-quit', async (e) => {
  if (isQuitting) return;
  e.preventDefault();
  isQuitting = true;

  for (const controller of activeRagStreams.values()) {
    controller.abort();
  }
  activeRagStreams.clear();
  
  try {
    const state = await workspaceService.getState();
    if (state.success && state.data) {
      for (const ws of state.data.workspaces) {
        await fileSystemService.emptyTrash(ws.id).catch(() => {});
      }
    }
  } catch (error) {
    // Ignore errors during quit
  }
  
  app.quit();
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

ipcMain.handle('file:readFileBase64', async (_, filePath: string) => {
  return await fileService.readFileBase64(filePath);
});

ipcMain.handle('file:getFileStats', async (_, filePath: string) => {
  return await fileService.getFileStats(filePath);
});

ipcMain.handle('file:writeMarkdown', async (_, filePath: string, content: string) => {
  return await fileService.writeMarkdown(filePath, content);
});

ipcMain.handle('app:showMessageBox', async (event, options: any) => {
  const win = getWindowFromEvent(event) ?? mainWindow;
  if (!win) return { response: 0 };
  return await dialog.showMessageBox(win, options);
});

ipcMain.handle('appSettings:get', async () => {
  return await appSettingsService.getSettings();
});

ipcMain.handle('appSettings:set', async (_, settings: any) => {
  return await appSettingsService.setSettings(settings);
});

ipcMain.handle('ollama:listModels', async (_, baseUrl: string) => {
  return await ollamaService.listModels(baseUrl);
});

ipcMain.handle('ollama:checkInstalled', async (_, baseUrl: string) => {
  return await ollamaService.checkInstalled(baseUrl);
});

ipcMain.handle('ollama:downloadInstaller', async (event) => {
  return await ollamaService.downloadInstaller(event);
});

ipcMain.handle('ollama:cancelDownload', async () => {
  return await ollamaService.cancelDownload();
});

ipcMain.handle('ollama:pullModel', async (event, baseUrl: string, model: string) => {
  return await ollamaService.pullModel(event, baseUrl, model);
});

ipcMain.handle('ollama:cancelPullModel', async (_, model: string) => {
  return await ollamaService.cancelPullModel(model);
});

ipcMain.handle('ollama:deleteModel', async (_, baseUrl: string, model: string) => {
  return await ollamaService.deleteModel(baseUrl, model);
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

ipcMain.handle('workspace:setActive', async (event, id: string | null) => {
  const r = await workspaceService.setActiveWorkspace(id);
  if (r.success) await setWindowTitleForWorkspace(id, getWindowFromEvent(event));
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

ipcMain.handle('workspaceAi:get', async (_, workspaceId: string) => {
  return await workspaceAiService.getState(workspaceId);
});

ipcMain.handle('workspaceAi:set', async (_, workspaceId: string, state: any) => {
  return await workspaceAiService.setState(workspaceId, state);
});

const getWorkspacePathById = async (workspaceId: string) => {
  const state = await workspaceService.getState();
  if (!state.success || !state.data) return null;
  const ws = state.data.workspaces.find((w) => w.id === workspaceId);
  return ws?.path ?? null;
};

ipcMain.handle('rag:health', async () => {
  return await ragService.health();
});

ipcMain.handle('rag:status', async (_, workspaceId: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  return await ragService.getIndexStatus(workspacePath, await getRagAiSettings());
});

ipcMain.handle('rag:index', async (_, workspaceId: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  return await ragService.buildVectorIndex(workspacePath, await getRagAiSettings());
});

ipcMain.handle('rag:ask', async (_, workspaceId: string, question: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  if (!question.trim()) return { success: false, error: 'Question is required' };
  return await ragService.queryAssistant(workspacePath, question, await getRagAiSettings());
});

ipcMain.handle('rag:askStream:start', async (event, requestId: string, workspaceId: string, question: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  if (!question.trim()) return { success: false, error: 'Question is required' };

  activeRagStreams.get(requestId)?.abort();
  const controller = new AbortController();
  activeRagStreams.set(requestId, controller);
  const sender = event.sender;

  ragService
    .streamAssistant(
      workspacePath,
      question,
      await getRagAiSettings(),
      (payload) => {
        if (sender.isDestroyed()) return;
        sender.send('rag:askStream:event', { requestId, ...payload });
      },
      controller.signal,
    )
    .then((result) => {
      if (!result.success && !sender.isDestroyed()) {
        sender.send('rag:askStream:event', {
          requestId,
          type: 'error',
          error: result.error || 'AI 助手请求失败。',
        });
      }
    })
    .finally(() => {
      if (activeRagStreams.get(requestId) === controller) {
        activeRagStreams.delete(requestId);
      }
    });

  return { success: true };
});

ipcMain.handle('rag:askStream:cancel', async (_, requestId: string) => {
  activeRagStreams.get(requestId)?.abort();
  activeRagStreams.delete(requestId);
  return { success: true };
});

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

ipcMain.handle('fs:emptyTrash', async (_, workspaceId: string) => {
  return await fileSystemService.emptyTrash(workspaceId);
});

ipcMain.handle('fs:watchStart', async (event, workspaceId: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  fileWatchService.start(workspaceId, workspacePath, event.sender);
  return { success: true };
});

ipcMain.handle('fs:watchAdd', async (event, workspaceId: string, dirRelativePaths: string[]) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  const paths = Array.isArray(dirRelativePaths) ? dirRelativePaths : [];
  fileWatchService.add(workspaceId, workspacePath, event.sender, paths);
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

ipcMain.handle('fs:isFile', async (_, workspaceId: string, targetRelativePath: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  return await fileSystemService.isFile(workspacePath, targetRelativePath);
});



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
