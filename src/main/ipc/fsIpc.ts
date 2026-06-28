import { ipcMain, shell } from 'electron';
import { getWorkspacePathById } from './workspaceIpc';
import { fileSystemService, fileWatchService } from '../services/file/fileSystemService';
import path from 'path';

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