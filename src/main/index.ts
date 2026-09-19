import { app, BrowserWindow, Menu, screen } from 'electron';
import path from 'path';
import { createOpenWithController } from './ipc/externalDocumentsIpc';
import { markdownArguments } from './services/app/openWithRouting';
import { fileURLToPath } from 'url';
import { workspaceService } from './services/workspace/workspaceService';
import { workspaceAiService } from './services/workspace/workspaceAiService';
import { fileSystemService } from './services/file/fileSystemService';
import { abortAllAgentRuns } from './ipc/agentIpc';
import { setWindowTitleForWorkspace } from './ipc/workspaceIpc';
import { startBundledRagService, stopBundledRagService } from './services/rag/ragServiceProcess';
import { prepareWindowsForQuit } from './services/app/quitCoordinator';
import { initializeAutoUpdateService } from './services/app/autoUpdate';
import { getWindowChromeOptions } from '../shared/utils/window-chrome';
import { createViewMenuTemplate } from '../shared/utils/app-menu';
import './ipc/appSettingsIpc';
import './ipc/ragIpc';
import './ipc/appIpc';
import './ipc/fileIpc';
import './ipc/fsIpc';
import './ipc/ollamaIpc';
import './ipc/noteTemplateIpc';

let mainWindow: BrowserWindow | null = null;
let quitInProgress = false;
let quitAllowed = false;
let openedWorkspaceWindow = false;

app.setAppUserModelId('com.looma')
app.setName('Looma');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const buildAppMenu = (win: BrowserWindow) => {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开工作空间（新窗口）…',
          click: () => win.webContents.send('app:command', { id: 'workspace.switch' }),
        },
        {
          label: '新建工作空间（新窗口）…',
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
      submenu: createViewMenuTemplate(),
    },
  ];
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about', label: `关于 ${app.name}` },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${app.name}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${app.name}` },
      ],
    });
  }
  return Menu.buildFromTemplate(template);
};

function createWindow(initialWorkspaceId?: string, editorOnly = false) {
  if (!editorOnly) {
    openedWorkspaceWindow = true;
    void startBundledRagService().catch(console.error);
  }
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
  const windowChromeOptions = getWindowChromeOptions(process.platform);
  const preloadPath = process.env.VITE_DEV_SERVER_URL
    ? path.join(process.cwd(), 'dist-electron', 'preload.cjs')
    : path.join(__dirname, 'preload.cjs');

  const win = new BrowserWindow({
    width: defaultWidth,
    height: defaultHeight,
    x: position.x,
    y: position.y,
    ...windowChromeOptions,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;
  openWith.register(win);
  win.setIcon(path.join(__dirname, '../resources/icon.png'));

  // 拦截所有 window.open：http/https 交给系统默认浏览器，其余一律拒绝
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      void import('electron').then(({ shell }) => shell.openExternal(url));
    }
    return { action: 'deny' };
  });

  // 拦截页面内导航：只允许应用自身页面，外部 URL 交给系统默认浏览器
  win.webContents.on('will-navigate', (event, url) => {
    const currentUrl = win.webContents.getURL();
    const isSameAppPage = url === currentUrl
      || (process.env.VITE_DEV_SERVER_URL && url.startsWith(process.env.VITE_DEV_SERVER_URL));
    if (!isSameAppPage) {
      event.preventDefault();
      if (/^https?:/i.test(url)) {
        void import('electron').then(({ shell }) => shell.openExternal(url));
      }
    }
  });

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
    if (editorOnly) url.searchParams.set('editorOnly', '1');
    win.loadURL(url.toString());
  } else {
    const query: Record<string, string> = {};
    if (initialWorkspaceId) query.workspaceId = initialWorkspaceId;
    if (editorOnly) query.editorOnly = '1';
    win.loadFile(path.join(__dirname, '../dist/index.html'), { query });
  }
  return win;
}

const openWith = createOpenWithController(() => createWindow(undefined, true), id => createWindow(id));
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  openWith.enqueue([filePath]);
});
openWith.enqueue(markdownArguments(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd()));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv, cwd) => {
    const files = markdownArguments(argv, cwd);
    if (files.length) { openWith.enqueue(files); return; }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    initializeAutoUpdateService(prepareAppForUpdate);
    await openWith.start();
    if (openWith.hasPending() || BrowserWindow.getAllWindows().length) return;

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

  app.on('activate', () => {
    if (!quitInProgress && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

const cleanupBeforeQuit = async () => {
  abortAllAgentRuns();

  if (!await prepareWindowsForQuit(BrowserWindow.getAllWindows())) return false;
  await workspaceAiService.flush();
  await stopBundledRagService();

  if (!openedWorkspaceWindow) return true;
  const state = await workspaceService.getState();
  if (state.success && state.data) {
    for (const ws of state.data.workspaces) {
      await fileSystemService.emptyTrash(ws.id).catch(() => {});
    }
  }
  return true;
};

const prepareAppForUpdate = async () => {
  if (quitInProgress) throw new Error('正在关闭窗口，请稍后重试');
  quitInProgress = true;
  try {
    if (!await cleanupBeforeQuit()) throw new Error('已取消安装更新');
    quitAllowed = true;
  } catch (error) {
    quitInProgress = false;
    quitAllowed = false;
    throw error;
  }
};

const finishAppQuit = async () => {

  try {
    if (!await cleanupBeforeQuit()) {
      quitInProgress = false;
      return;
    }
  } catch (error) {
    quitInProgress = false;
    console.error(`[quit] ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Only a successful, acknowledged close may allow the second quit pass.
    if (quitInProgress) {
      quitAllowed = true;
      app.quit();
    }
  }
};

app.on('before-quit', (e) => {
  if (quitAllowed) return;
  e.preventDefault();
  if (quitInProgress) return;
  quitInProgress = true;
  void finishAppQuit();
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
