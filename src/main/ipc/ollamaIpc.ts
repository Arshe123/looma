import { ipcMain } from 'electron';
import { ollamaService } from '../services/ollama/ollamaService';

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