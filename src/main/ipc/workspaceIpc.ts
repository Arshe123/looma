import { ipcMain, dialog, BrowserWindow } from 'electron';
import { workspaceAiService } from '../services/workspace/workspaceAiService';
import { workspaceMetaService } from '../services/workspace/workspaceMetaService';
import { workspaceService } from '../services/workspace/workspaceService';
import { mainWindow } from '../index';
import { getWindowFromEvent } from './windowIpc';
import fs from 'fs/promises';
import path from 'path';

const getWorkspacePathById = async (workspaceId: string) => {
  const state = await workspaceService.getState();
  if (!state.success || !state.data) return null;
  const ws = state.data.workspaces.find((w) => w.id === workspaceId);
  return ws?.path ?? null;
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

export {
  getWorkspacePathById,
  setWindowTitleForWorkspace,
  getWorkspaceById
}