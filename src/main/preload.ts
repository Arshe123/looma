import { contextBridge, ipcRenderer } from 'electron';

type FsEventPayload = { workspaceId: string; event: string; relativePath: string };

contextBridge.exposeInMainWorld('electronAPI', {
  file: {
    readMarkdown: (filePath: string) => ipcRenderer.invoke('file:readMarkdown', filePath),
    writeMarkdown: (filePath: string, content: string) => ipcRenderer.invoke('file:writeMarkdown', filePath, content),
  },
  workspace: {
    selectDir: () => ipcRenderer.invoke('workspace:selectDir'),
    getState: () => ipcRenderer.invoke('workspace:getState'),
    list: () => ipcRenderer.invoke('workspace:list'),
    create: (workspacePath: string, name?: string) => ipcRenderer.invoke('workspace:create', workspacePath, name),
    rename: (id: string, newName: string) => ipcRenderer.invoke('workspace:rename', id, newName),
    remove: (id: string) => ipcRenderer.invoke('workspace:remove', id),
    reorder: (order: string[]) => ipcRenderer.invoke('workspace:reorder', order),
    setActive: (id: string) => ipcRenderer.invoke('workspace:setActive', id),
  },
  workspaceMeta: {
    get: (workspaceId: string) => ipcRenderer.invoke('workspaceMeta:get', workspaceId),
    set: (workspaceId: string, meta: { expandedDirs: string[]; selectedPaths: string[]; noteOrder: Record<string, string[]> }) =>
      ipcRenderer.invoke('workspaceMeta:set', workspaceId, meta),
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
    delete: (workspaceId: string, targetRelativePath: string) => ipcRenderer.invoke('fs:delete', workspaceId, targetRelativePath),
    restore: (workspaceId: string, trashRelativePath: string, restoreToRelativePath: string) =>
      ipcRenderer.invoke('fs:restore', workspaceId, trashRelativePath, restoreToRelativePath),
    watchStart: (workspaceId: string) => ipcRenderer.invoke('fs:watchStart', workspaceId),
    watchStop: (workspaceId: string) => ipcRenderer.invoke('fs:watchStop', workspaceId),
    onEvent: (listener: (payload: FsEventPayload) => void) => {
      const handler = (_: unknown, payload: FsEventPayload) => listener(payload);
      ipcRenderer.on('fs:event', handler);
      return () => ipcRenderer.removeListener('fs:event', handler);
    },
  },
  window: {
    close: () => ipcRenderer.invoke('window:close'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    openWorkspace: (workspaceId: string) => ipcRenderer.invoke('window:openWorkspace', workspaceId),
  },
});
