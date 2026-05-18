import type { Result } from '@/common/interface/Result'

type SidebarPanelId = 'files' | 'outline' | 'ai';

interface SidebarPanelState {
  id: SidebarPanelId;
  size: number;
}

interface WorkspaceMetaPayload {
  expandedDirs: string[];
  selectedPaths: string[];
  noteOrder: Record<string, string[]>;
  openedFiles?: string[];
  activeFile?: string;
  fileSessions?: Record<string, any>;
  activeSidebarPanel?: SidebarPanelId | null;
  sidebarPanels?: SidebarPanelState[];
}

interface AppSettingsPayload {
  inlineMenu: {
    items: string[];
  };
}

interface ElectronAPI {
  file: {
    readMarkdown: (filePath: string) => Promise<Result<string>>;
    readFileBase64: (filePath: string) => Promise<Result<string>>;
    getFileStats: (filePath: string) => Promise<Result<{ size: number }>>;
    writeMarkdown: (filePath: string, content: string) => Promise<Result<void>>;
  };
  app: {
    onCommand: (listener: (payload: { id: string }) => void) => () => void;
    showMessageBox: (options: any) => Promise<{ response: number; checkboxChecked: boolean }>;
  };
  workspace: {
    selectDir: () => Promise<string | null>;
    getState: () => Promise<Result<{
      workspaces: Array<{ id: string; name: string; path: string; createdAt: number; lastOpenedAt: number }>;
      order: string[];
      activeId: string | null;
    }>>;
    list: () => Promise<Result<Array<{ id: string; name: string; path: string; createdAt: number; lastOpenedAt: number }>>>;
    create: (workspacePath: string, name?: string) => Promise<Result<{ id: string; name: string; path: string }>>;
    new: (parentDir: string, name: string, template?: 'empty' | 'basic') => Promise<Result<{ id: string; name: string; path: string }>>;
    rename: (id: string, newName: string) => Promise<Result<void>>;
    remove: (id: string) => Promise<Result<void>>;
    reorder: (order: string[]) => Promise<Result<void>>;
    checkExists: (id: string) => Promise<Result<{ exists: boolean, path: string, name: string }>>;
    recreate: (id: string) => Promise<Result<void>>;
    setActive: (id: string | null) => Promise<Result<void>>;
  };
  workspaceMeta: {
    get: (workspaceId: string) => Promise<Result<WorkspaceMetaPayload>>;
    set: (workspaceId: string, meta: WorkspaceMetaPayload) => Promise<Result<void>>;
  };
  appSettings: {
    get: () => Promise<Result<AppSettingsPayload>>;
    set: (settings: AppSettingsPayload) => Promise<Result<void>>;
  };
  fs: {
    listDir: (workspaceId: string, dirRelativePath: string) => Promise<Result<Array<{ name: string; relativePath: string; isDirectory: boolean; size: number; mtimeMs: number }>>>;
    rename: (workspaceId: string, targetRelativePath: string, newName: string) => Promise<Result<void>>;
    createFolder: (workspaceId: string, parentDirRelativePath: string, name: string) => Promise<Result<string>>;
    createFile: (workspaceId: string, parentDirRelativePath: string, name: string) => Promise<Result<string>>;
    move: (workspaceId: string, fromRelativePath: string, toRelativePath: string) => Promise<Result<void>>;
    delete: (workspaceId: string, targetRelativePath: string) => Promise<Result<{ trashRelativePath: string }>>;
    restore: (workspaceId: string, trashRelativePath: string, restoreToRelativePath: string) => Promise<Result<void>>;
    emptyTrash: (workspaceId: string) => Promise<Result<void>>;
    watchStart: (workspaceId: string) => Promise<Result<void>>;
    watchAdd: (workspaceId: string, dirRelativePaths: string[]) => Promise<Result<void>>;
    watchStop: (workspaceId: string) => Promise<Result<void>>;
    showItemInFolder: (workspaceId: string, relativePath: string) => Promise<Result<void>>;
    isFile: (workspaceId: string, targetRelativePath: string) => Promise<Result<boolean>>;
    onEvent: (listener: (payload: { workspaceId: string; event: string; relativePath: string }) => void) => () => void;
  };
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    onPrepareClose: (callback: () => void) => () => void;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
