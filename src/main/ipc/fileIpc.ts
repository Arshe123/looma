import { ipcMain } from 'electron';
import { fileService } from '../services/file/fileService';

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