import { ipcMain, app } from 'electron';
import { aiService, type AISettings, type RagChatMessage, type RagRequestStats } from '../services/ai/AIService';
import { normalizeOllamaBaseUrl } from '../services/ollama/ollamaService';
import { getWorkspacePathById }  from './workspaceIpc';
import { appSettingsService } from './appSettingsIpc';

const activeRagIndexStreams = new Map<string, AbortController>();

const activeRagStreams = new Map<string, AbortController>();

const normalizeVectorStorePath = (value: string) => {
  return (value || '').trim() || '.looma/rag-index';
};

const getRagAiSettings = async (): Promise<AISettings & { vectorStorePath: string }> => {
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
  };
};

const normalizeRagHistory = (history: unknown): RagChatMessage[] => {
  if (!Array.isArray(history)) return [];
  const allowedRoles = new Set(['user', 'assistant', 'system', 'tool']);
  return history
    .filter((item): item is RagChatMessage => Boolean(
      item
      && typeof item === 'object'
      && allowedRoles.has((item as any).role)
      && typeof (item as any).content === 'string'
      && (item as any).content.trim().length > 0,
    ))
    .map((item) => ({
      role: item.role,
      content: item.content.trim(),
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : undefined,
    }));
};

const normalizeRagRequestStats = (stats: unknown): RagRequestStats => {
  const raw = stats && typeof stats === 'object' ? stats as Record<string, unknown> : {};
  const toNonNegativeInt = (value: unknown) => {
    const numberValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numberValue) && numberValue > 0 ? Math.round(numberValue) : 0;
  };
  return {
    history_messages: toNonNegativeInt(raw.history_messages),
    history_token_estimate: toNonNegativeInt(raw.history_token_estimate),
    question_token_estimate: toNonNegativeInt(raw.question_token_estimate),
    total_token_estimate: toNonNegativeInt(raw.total_token_estimate),
    recent_turns: toNonNegativeInt(raw.recent_turns),
    distant_summary_enabled: raw.distant_summary_enabled === true,
    distant_summary_messages: toNonNegativeInt(raw.distant_summary_messages),
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

ipcMain.handle('rag:chat', async (_, workspaceId: string, question: string, history?: unknown, requestStats?: unknown) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  if (!question.trim()) return { success: false, error: 'Question is required' };
  return await aiService.chat(
    workspacePath,
    question,
    await getRagAiSettings(),
    normalizeRagHistory(history),
    normalizeRagRequestStats(requestStats),
  );
});

ipcMain.handle('rag:summarizeConversation', async (_, messages?: unknown, maxChars?: unknown) => {
  const normalizedMessages = normalizeRagHistory(messages);
  if (!normalizedMessages.length) return { success: false, error: 'Messages are required' };
  const parsedMaxChars = typeof maxChars === 'number' ? maxChars : Number(maxChars);
  const boundedMaxChars = Number.isFinite(parsedMaxChars) ? Math.min(8000, Math.max(200, Math.round(parsedMaxChars))) : 1200;
  return await aiService.summarizeConversation(
    normalizedMessages,
    boundedMaxChars,
    await getRagAiSettings(),
  );
});

ipcMain.handle('rag:askStream:start', async (event, requestId: string, workspaceId: string, question: string, history?: unknown, requestStats?: unknown) => {
  const workspacePath = await getWorkspacePathById(workspaceId);
  if (!workspacePath) return { success: false, error: 'Workspace not found' };
  if (!question.trim()) return { success: false, error: 'Question is required' };

  activeRagStreams.get(requestId)?.abort();
  const controller = new AbortController();
  activeRagStreams.set(requestId, controller);
  const sender = event.sender;

  aiService
    .streamAssistant(
      workspacePath,
      question,
      await getRagAiSettings(),
      normalizeRagHistory(history),
      normalizeRagRequestStats(requestStats),
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

export {
    activeRagStreams,
}