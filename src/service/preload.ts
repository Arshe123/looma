import { contextBridge, ipcRenderer } from 'electron';

type FsEventPayload = { workspaceId: string; event: string; relativePath: string };
type RagStreamEventPayload =
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'sources'; sources: unknown[] }
  | { requestId: string; type: 'done' }
  | { requestId: string; type: 'error'; error: string };
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
  file: {
    readMarkdown: (filePath: string) => ipcRenderer.invoke('file:readMarkdown', filePath),
    readFileBase64: (filePath: string) => ipcRenderer.invoke('file:readFileBase64', filePath),
    getFileStats: (filePath: string) => ipcRenderer.invoke('file:getFileStats', filePath),
    writeMarkdown: (filePath: string, content: string) => ipcRenderer.invoke('file:writeMarkdown', filePath, content),
  },
  app: {
    onCommand: (listener: (payload: { id: string }) => void) => {
      const handler = (_: unknown, payload: { id: string }) => listener(payload);
      ipcRenderer.on('app:command', handler);
      return () => ipcRenderer.removeListener('app:command', handler);
    },
    showMessageBox: (options: any) => ipcRenderer.invoke('app:showMessageBox', options),
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
    index: (workspaceId: string) => ipcRenderer.invoke('rag:index', workspaceId),
    ask: (workspaceId: string, question: string) => ipcRenderer.invoke('rag:ask', workspaceId, question),
    askStream: {
      start: (requestId: string, workspaceId: string, question: string) =>
        ipcRenderer.invoke('rag:askStream:start', requestId, workspaceId, question),
      cancel: (requestId: string) => ipcRenderer.invoke('rag:askStream:cancel', requestId),
      onEvent: (listener: (payload: RagStreamEventPayload) => void) => {
        const handler = (_: unknown, payload: RagStreamEventPayload) => listener(payload);
        ipcRenderer.on('rag:askStream:event', handler);
        return () => ipcRenderer.removeListener('rag:askStream:event', handler);
      },
    },
  },
  fs: {
    listDir: (workspaceId: string, dirRelativePath: string) => ipcRenderer.invoke('fs:listDir', workspaceId, dirRelativePath),
    createFolder: (workspaceId: string, parentDirRelativePath: string, name: string) =>
      ipcRenderer.invoke('fs:createFolder', workspaceId, parentDirRelativePath, name),
    createFile: (workspaceId: string, parentDirRelativePath: string, name: string) =>
      ipcRenderer.invoke('fs:createFile', workspaceId, parentDirRelativePath, name),
    rename: (workspaceId: string, targetRelativePath: string, newName: string) =>
      ipcRenderer.invoke('fs:rename', workspaceId, targetRelativePath, newName),
    move: (workspaceId: string, fromRelativePath: string, toRelativePath: string) =>
      ipcRenderer.invoke('fs:move', workspaceId, fromRelativePath, toRelativePath),
    delete: (workspaceId: string, targetRelativePath: string) =>
      ipcRenderer.invoke('fs:delete', workspaceId, targetRelativePath),
    restore: (workspaceId: string, trashRelativePath: string, restoreToRelativePath: string) =>
      ipcRenderer.invoke('fs:restore', workspaceId, trashRelativePath, restoreToRelativePath),
    emptyTrash: (workspaceId: string) => ipcRenderer.invoke('fs:emptyTrash', workspaceId),
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
