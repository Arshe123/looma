import { contextBridge, ipcRenderer } from 'electron';

type FsEventPayload = { workspaceId: string; event: string; relativePath: string };

contextBridge.exposeInMainWorld('electronAPI', {
  file: {
    readMarkdown: (filePath: string) => ipcRenderer.invoke('file:readMarkdown', filePath),
    readFileBase64: (filePath: string) => ipcRenderer.invoke('file:readFileBase64', filePath),
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
    recreate: (id: string) => ipcRenderer.invoke('workspace:recreate', id),
    setActive: (id: string | null) => ipcRenderer.invoke('workspace:setActive', id),
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
