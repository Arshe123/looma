import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import { fileService } from '../services/file/fileService';
import { fileWatchService } from '../services/file/fileSystemService';

// IPC Handlers for File Service
ipcMain.handle('file:readMarkdown', async (_, filePath: string) => {
  return await fileService.readMarkdown(filePath);
});

ipcMain.handle('file:readTextChunk', async (_, filePath: string, offset: number, length: number) => {
  return await fileService.readTextChunk(filePath, offset, length);
});

ipcMain.handle('file:readFileBase64', async (_, filePath: string) => {
  return await fileService.readFileBase64(filePath);
});

ipcMain.handle('file:getFileStats', async (_, filePath: string) => {
  return await fileService.getFileStats(filePath);
});

ipcMain.handle('file:selectAndCopyImage', async (event, noteFilePath: string) => {
  const options: OpenDialogOptions = {
    title: '选择要插入的图片',
    properties: ['openFile'],
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
    ],
  };
  const owner = BrowserWindow.fromWebContents(event.sender);
  const selected = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (selected.canceled || !selected.filePaths[0]) {
    return { success: true, data: null };
  }
  return await fileService.copyImageToNoteAssets(noteFilePath, selected.filePaths[0]);
});

ipcMain.handle('file:writeMarkdown', async (event, filePath: string, content: string, expectedContent?: string) => {
  const writeToken = fileWatchService.registerEditorWrite(event.sender, filePath, content);
  const result = await fileService.writeMarkdown(filePath, content, expectedContent);
  if (!result.success) fileWatchService.cancelEditorWrite(event.sender, filePath, writeToken);
  return result;
});
