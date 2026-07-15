import { ipcMain } from 'electron';
import { aiService, type AISettings } from '../services/ai/AIService';
import { normalizeOllamaBaseUrl } from '../services/ollama/ollamaService';
import { getWorkspacePathById }  from './workspaceIpc';
import { appSettingsService } from './appSettingsIpc';

const activeRagIndexStreams = new Map<string, AbortController>();


type RagRuntimeSettings = AISettings & {
  vectorStorePath: string
  chunkSize: number
  chunkOverlap: number
  chunkingStrategy: 'fixed' | 'markdown' | 'semantic' | 'parent_child' | 'code_aware'
}


const normalizeVectorStorePath = (value: string) => {
  return (value || '').trim() || '.looma/rag-index';
};

const getRagAiSettings = async (): Promise<RagRuntimeSettings> => {
  const result = await appSettingsService.getSettings();
  const ai = result.success && result.data ? result.data.ai : undefined;
  return {
    chat: ai?.chat ?? {
      provider: 'ollama',
      model: 'qwen2.5:7b',
      baseUrl: normalizeOllamaBaseUrl(''),
      apiKey: '',
      temperature: 0.7,
    },
    embedding: ai?.embedding ?? {
      provider: 'ollama',
      model: 'bge-m3:latest',
      baseUrl: normalizeOllamaBaseUrl(''),
      apiKey: '',
    },
    vectorStorePath: normalizeVectorStorePath(ai?.vectorStorePath ?? ''),
    chunkSize: ai?.chunkSize ?? 800,
    chunkOverlap: ai?.chunkOverlap ?? 100,
    chunkingStrategy: ai?.chunkingStrategy ?? 'fixed',
  };
};


ipcMain.handle('rag:health', async () => {
  return await aiService.health();
});

ipcMain.handle('rag:status', async (_, workspaceId: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  return await aiService.getIndexStatus(workspacePath, await getRagAiSettings());
});

ipcMain.handle('rag:indexStream:start', async (event, requestId: string, workspaceId: string, mode: 'incremental' | 'full' | 'retry_failed' = 'incremental') => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };

  activeRagIndexStreams.get(requestId)?.abort();
  const controller = new AbortController();
  activeRagIndexStreams.set(requestId, controller);
  const sender = event.sender;

  aiService
    .streamBuildManagedIndex(
      workspacePath,
      mode,
      (payload) => {
        if (sender.isDestroyed()) return;
        sender.send('rag:indexStream:event', { requestId, ...payload });
      },
      controller.signal,
    )
    .then((result) => {
      if (!result.success && !sender.isDestroyed()) {
        sender.send('rag:indexStream:event', {
          requestId,
          type: 'error',
          error: result.error || '建立索引失败。',
        });
      }
    })
    .finally(() => {
      if (activeRagIndexStreams.get(requestId) === controller) {
        activeRagIndexStreams.delete(requestId);
      }
    });

  return { success: true };
});

ipcMain.handle('rag:indexStream:cancel', async (_, requestId: string) => {
  activeRagIndexStreams.get(requestId)?.abort();
  activeRagIndexStreams.delete(requestId);
  return { success: true };
});


ipcMain.handle('rag:indexFile:chunks', async (_, workspaceId: string, relativePath: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  if (!relativePath?.trim()) return { success: false, error: 'Path is required' };
  return await aiService.getFileChunks(workspacePath, relativePath);
});

ipcMain.handle('rag:indexFile:reindex', async (_, workspaceId: string, relativePath: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  if (!relativePath?.trim()) return { success: false, error: 'Path is required' };
  return await aiService.reindexFile(workspacePath, relativePath);
});

ipcMain.handle('rag:index:delete', async (_, workspaceId: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  return await aiService.deleteAllIndex(workspacePath);
});

ipcMain.handle('rag:indexFile:delete', async (_, workspaceId: string, relativePath: string) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  if (!relativePath?.trim()) return { success: false, error: 'Path is required' };
  return await aiService.deleteFileIndex(workspacePath, relativePath);
});

