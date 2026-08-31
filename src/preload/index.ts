import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateState } from '../shared/types/app-update';

type FsEventPayload = { workspaceId: string; event: string; relativePath: string; origin: 'editor' | 'external' };
type RagStreamEventPayload =
  | { requestId: string; type: 'timeline'; stepId?: string; status?: 'pending' | 'active' | 'completed' | 'error'; title?: string; description?: string; detail?: string; outputs?: unknown[]; step?: Record<string, unknown> }
  | { requestId: string; type: 'progress'; stepId: string; current: number; total?: number; message?: string }
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'sources'; sources: unknown[] }
  | { requestId: string; type: 'done'; result?: Record<string, unknown>; status?: string; document_count?: number; exists?: boolean; persist_dir?: string }
  | { requestId: string; type: 'error'; error: string; stepId?: string };
type RagChatMessagePayload = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
};
type AgentToolNamePayload = 'rag_search' | 'workspace_list' | 'workspace_search' | 'file_read';
type AgentRunOptionsPayload = {
  input: string;
  history?: RagChatMessagePayload[];
  enabledTools?: AgentToolNamePayload[];
  maxIterations?: number;
  toolTimeoutSeconds?: number;
};
type AgentStreamEventPayload = { requestId: string; type: string; runId: string } & Record<string, unknown>;

type OllamaDownloadProgressPayload = {
  status: 'downloading' | 'completed' | 'error' | 'cancelled';
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
  error?: string;
};
type OllamaModelPullProgressPayload = OllamaDownloadProgressPayload & {
  model: string;
  message?: string;
};

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  file: {
    readMarkdown: (filePath: string) => ipcRenderer.invoke('file:readMarkdown', filePath),
    readTextChunk: (filePath: string, offset: number, length: number) =>
      ipcRenderer.invoke('file:readTextChunk', filePath, offset, length),
    readFileBase64: (filePath: string) => ipcRenderer.invoke('file:readFileBase64', filePath),
    getFileStats: (filePath: string) => ipcRenderer.invoke('file:getFileStats', filePath),
    selectAndCopyImage: (noteFilePath: string) => ipcRenderer.invoke('file:selectAndCopyImage', noteFilePath),
    writeMarkdown: (
      filePath: string,
      content: string,
      expectedContent?: string,
      options?: { allowEmptyContent?: boolean },
    ) => ipcRenderer.invoke('file:writeMarkdown', filePath, content, expectedContent, options),
  },
  app: {
    onCommand: (listener: (payload: { id: string }) => void) => {
      const handler = (_: unknown, payload: { id: string }) => listener(payload);
      ipcRenderer.on('app:command', handler);
      return () => ipcRenderer.removeListener('app:command', handler);
    },
    showMessageBox: (options: any) => ipcRenderer.invoke('app:showMessageBox', options),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    update: {
      getState: () => ipcRenderer.invoke('app:update:getState'),
      check: () => ipcRenderer.invoke('app:update:check'),
      download: () => ipcRenderer.invoke('app:update:download'),
      install: () => ipcRenderer.invoke('app:update:install'),
      onState: (listener: (payload: UpdateState) => void) => {
        const handler = (_: unknown, payload: UpdateState) => listener(payload);
        ipcRenderer.on('app:update:state', handler);
        return () => ipcRenderer.removeListener('app:update:state', handler);
      },
    },
  },
  workspace: {
    selectDir: () => ipcRenderer.invoke('workspace:selectDir'),
    getState: () => ipcRenderer.invoke('workspace:getState'),
    list: () => ipcRenderer.invoke('workspace:list'),
    create: (workspacePath: string, name?: string) => ipcRenderer.invoke('workspace:create', workspacePath, name),
    new: (parentDir: string, name: string, template?: 'empty' | 'basic') => ipcRenderer.invoke('workspace:new', parentDir, name, template),
    rename: (id: string, newName: string) => ipcRenderer.invoke('workspace:rename', id, newName),
    remove: (id: string) => ipcRenderer.invoke('workspace:remove', id),
    reorder: (order: string[]) => ipcRenderer.invoke('workspace:reorder', order),
    checkExists: (id: string) => ipcRenderer.invoke('workspace:checkExists', id),
    setActive: (id: string | null) => ipcRenderer.invoke('workspace:setActive', id),
  },
  workspaceMeta: {
    get: (workspaceId: string) => ipcRenderer.invoke('workspaceMeta:get', workspaceId),
    set: (workspaceId: string, meta: unknown) =>
      ipcRenderer.invoke('workspaceMeta:set', workspaceId, meta),
  },
  draftRecovery: {
    save: (input: { workspaceId: string; relativePath: string; draftContent: string; baseContent: string; revision: string }) =>
      ipcRenderer.invoke('draftRecovery:save', input),
    get: (workspaceId: string, relativePath: string, diskContent: string) =>
      ipcRenderer.invoke('draftRecovery:get', workspaceId, relativePath, diskContent),
    remove: (workspaceId: string, relativePath: string, expectedRevision?: string) =>
      ipcRenderer.invoke('draftRecovery:remove', workspaceId, relativePath, expectedRevision),
    move: (workspaceId: string, fromRelativePath: string, toRelativePath: string, expectedRevision: string) =>
      ipcRenderer.invoke('draftRecovery:move', workspaceId, fromRelativePath, toRelativePath, expectedRevision),
    movePaths: (workspaceId: string, items: { from: string; to: string }[]) =>
      ipcRenderer.invoke('draftRecovery:movePaths', workspaceId, items),
    removePaths: (workspaceId: string, relativePaths: string[]) =>
      ipcRenderer.invoke('draftRecovery:removePaths', workspaceId, relativePaths),
  },
  workspaceAi: {
    get: (workspaceId: string) => ipcRenderer.invoke('workspaceAi:get', workspaceId),
    set: (workspaceId: string, state: unknown) => ipcRenderer.invoke('workspaceAi:set', workspaceId, state),
  },
  appSettings: {
    get: () => ipcRenderer.invoke('appSettings:get'),
    set: (settings: unknown) => ipcRenderer.invoke('appSettings:set', settings),
  },
  ollama: {
    listModels: (baseUrl: string) => ipcRenderer.invoke('ollama:listModels', baseUrl),
    checkInstalled: (baseUrl: string) => ipcRenderer.invoke('ollama:checkInstalled', baseUrl),
    downloadInstaller: () => ipcRenderer.invoke('ollama:downloadInstaller'),
    cancelDownload: () => ipcRenderer.invoke('ollama:cancelDownload'),
    pullModel: (baseUrl: string, model: string) => ipcRenderer.invoke('ollama:pullModel', baseUrl, model),
    cancelPullModel: (model: string) => ipcRenderer.invoke('ollama:cancelPullModel', model),
    deleteModel: (baseUrl: string, model: string) => ipcRenderer.invoke('ollama:deleteModel', baseUrl, model),
    onDownloadProgress: (listener: (payload: OllamaDownloadProgressPayload) => void) => {
      const handler = (_: unknown, payload: OllamaDownloadProgressPayload) => listener(payload);
      ipcRenderer.on('ollama:downloadProgress', handler);
      return () => ipcRenderer.removeListener('ollama:downloadProgress', handler);
    },
    onPullModelProgress: (listener: (payload: OllamaModelPullProgressPayload) => void) => {
      const handler = (_: unknown, payload: OllamaModelPullProgressPayload) => listener(payload);
      ipcRenderer.on('ollama:pullModelProgress', handler);
      return () => ipcRenderer.removeListener('ollama:pullModelProgress', handler);
    },
  },
  rag: {
    health: () => ipcRenderer.invoke('rag:health'),
    status: (workspaceId: string) => ipcRenderer.invoke('rag:status', workspaceId),

    indexStream: {
      start: (requestId: string, workspaceId: string, mode: 'incremental' | 'full' | 'retry_failed' = 'incremental') =>
        ipcRenderer.invoke('rag:indexStream:start', requestId, workspaceId, mode),
      cancel: (requestId: string) => ipcRenderer.invoke('rag:indexStream:cancel', requestId),
      onEvent: (listener: (payload: RagStreamEventPayload) => void) => {
        const handler = (_: unknown, payload: RagStreamEventPayload) => listener(payload);
        ipcRenderer.on('rag:indexStream:event', handler);
        return () => ipcRenderer.removeListener('rag:indexStream:event', handler);
      },
    },
    indexFile: {
      reindex: (workspaceId: string, relativePath: string) => ipcRenderer.invoke('rag:indexFile:reindex', workspaceId, relativePath),
      chunks: (workspaceId: string, relativePath: string) => ipcRenderer.invoke('rag:indexFile:chunks', workspaceId, relativePath),
      delete: (workspaceId: string, relativePath: string) => ipcRenderer.invoke('rag:indexFile:delete', workspaceId, relativePath),
    },
    deleteIndex: (workspaceId: string) => ipcRenderer.invoke('rag:index:delete', workspaceId),
  },
  agent: {
    getRun: (workspaceId: string, runId: string) => ipcRenderer.invoke('agent:ledger:getRun', workspaceId, runId),
    getRuns: (workspaceId: string, runIds: string[]) => ipcRenderer.invoke('agent:ledger:getRuns', workspaceId, runIds),
    resumeRun: (requestId: string, workspaceId: string, parentRunId: string) => ipcRenderer.invoke('agent:runStream:resume', requestId, workspaceId, parentRunId),
    summarizeConversation: (messages: RagChatMessagePayload[], maxChars: number) =>
      ipcRenderer.invoke('agent:summarizeConversation', messages, maxChars),
    listApprovals: (workspaceId: string) => ipcRenderer.invoke('agent:approvals:list', workspaceId),
    resolveApproval: (workspaceId: string, approvalId: string, approved: boolean) =>
      ipcRenderer.invoke('agent:approval:resolve', workspaceId, approvalId, approved),
    runStream: {
      start: (requestId: string, workspaceId: string, options: AgentRunOptionsPayload) =>
        ipcRenderer.invoke('agent:runStream:start', requestId, workspaceId, options),
      cancel: (requestId: string) => ipcRenderer.invoke('agent:runStream:cancel', requestId),
      onEvent: (listener: (payload: AgentStreamEventPayload) => void) => {
        const handler = (_: unknown, payload: AgentStreamEventPayload) => listener(payload);
        ipcRenderer.on('agent:runStream:event', handler);
        return () => ipcRenderer.removeListener('agent:runStream:event', handler);
      },
    },
  },
  fs: {
    listDir: (workspaceId: string, dirRelativePath: string) => ipcRenderer.invoke('fs:listDir', workspaceId, dirRelativePath),
    listNotes: (workspaceId: string) => ipcRenderer.invoke('fs:listNotes', workspaceId),
    createFolder: (workspaceId: string, parentDirRelativePath: string, name: string) =>
      ipcRenderer.invoke('fs:createFolder', workspaceId, parentDirRelativePath, name),
    createFile: (workspaceId: string, parentDirRelativePath: string, name: string) =>
      ipcRenderer.invoke('fs:createFile', workspaceId, parentDirRelativePath, name),
    rename: (workspaceId: string, targetRelativePath: string, newName: string) =>
      ipcRenderer.invoke('fs:rename', workspaceId, targetRelativePath, newName),
    move: (workspaceId: string, fromRelativePath: string, toRelativePath: string) =>
      ipcRenderer.invoke('fs:move', workspaceId, fromRelativePath, toRelativePath),
    copyExternal: (workspaceId: string, sourcePaths: string[], targetDirRelativePath: string) =>
      ipcRenderer.invoke('fs:copyExternal', workspaceId, sourcePaths, targetDirRelativePath),
    copyEntries: (workspaceId: string, fromRelativePaths: string[], targetDirRelativePath: string) =>
      ipcRenderer.invoke('fs:copyEntries', workspaceId, fromRelativePaths, targetDirRelativePath),
    clipboardReadFiles: () => ipcRenderer.invoke('fs:clipboardReadFiles'),
    clipboardPasteImage: (workspaceId: string, targetDirRelativePath: string) =>
      ipcRenderer.invoke('fs:clipboardPasteImage', workspaceId, targetDirRelativePath),
    importImage: (workspaceId: string, noteRelativePath: string, sourceFilePath: string) =>
      ipcRenderer.invoke('fs:importImage', workspaceId, noteRelativePath, sourceFilePath),
    importClipboardImage: (workspaceId: string, noteRelativePath: string) =>
      ipcRenderer.invoke('fs:importClipboardImage', workspaceId, noteRelativePath),
    delete: (workspaceId: string, targetRelativePath: string) =>
      ipcRenderer.invoke('fs:delete', workspaceId, targetRelativePath),
    restore: (workspaceId: string, trashRelativePath: string, restoreToRelativePath: string) =>
      ipcRenderer.invoke('fs:restore', workspaceId, trashRelativePath, restoreToRelativePath),
    emptyTrash: (workspaceId: string) => ipcRenderer.invoke('fs:emptyTrash', workspaceId),
    listTrash: (workspaceId: string) => ipcRenderer.invoke('fs:listTrash', workspaceId),
    watchStart: (workspaceId: string) => ipcRenderer.invoke('fs:watchStart', workspaceId),
    watchAdd: (workspaceId: string, dirRelativePaths: string[]) => ipcRenderer.invoke('fs:watchAdd', workspaceId, dirRelativePaths),
    watchStop: (workspaceId: string) => ipcRenderer.invoke('fs:watchStop', workspaceId),
    showItemInFolder: (workspaceId: string, relativePath: string) => ipcRenderer.invoke('fs:showItemInFolder', workspaceId, relativePath),
    onEvent: (listener: (payload: FsEventPayload) => void) => {
      const handler = (_: unknown, payload: FsEventPayload) => listener(payload);
      ipcRenderer.on('fs:event', handler);
      return () => ipcRenderer.removeListener('fs:event', handler);
    },
    isFile: (workspaceId: string, targetRelativePath: string) => ipcRenderer.invoke('fs:isFile', workspaceId, targetRelativePath),
  },
  window: {
    close: () => ipcRenderer.invoke('window:close'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    openWorkspace: (workspaceId: string) => ipcRenderer.invoke('window:openWorkspace', workspaceId),
    onPrepareClose: (callback: () => void) => {
      ipcRenderer.on('window:prepare-close', callback)
      return () => ipcRenderer.removeAllListeners('window:prepare-close')
    },
  },
});
