import { app, BrowserWindow, Menu, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { telemetryService } from './services/user/telemetryService';
import { workspaceService } from './services/workspace/workspaceService';
import { fileSystemService } from './services/file/fileSystemService';
import { activeRagStreams } from './ipc/ragIpc';
import { setWindowTitleForWorkspace } from './ipc/workspaceIpc';
import './ipc/appIpc';
import './ipc/fileIpc';
import './ipc/fsIpc';
import './ipc/ollamaIpc';

let mainWindow: BrowserWindow | null = null;

app.setAppUserModelId('com.looma')
app.setName('looma');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  win.setIcon(path.join(__dirname, '../resources/icon.png'));

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

export {
  mainWindow,
  createWindow,
}