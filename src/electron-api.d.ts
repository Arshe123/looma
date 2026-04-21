export interface Result<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ElectronAPI {
  file: {
    readMarkdown: (filePath: string) => Promise<Result<string>>;
    writeMarkdown: (filePath: string, content: string) => Promise<Result<void>>;
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
    rename: (id: string, newName: string) => Promise<Result<void>>;
    remove: (id: string) => Promise<Result<void>>;
    reorder: (order: string[]) => Promise<Result<void>>;
    setActive: (id: string) => Promise<Result<void>>;
  };
  workspaceMeta: {
    get: (workspaceId: string) => Promise<Result<{ expandedDirs: string[]; selectedPaths: string[]; noteOrder: Record<string, string[]> }>>;
    set: (workspaceId: string, meta: { expandedDirs: string[]; selectedPaths: string[]; noteOrder: Record<string, string[]> }) => Promise<Result<void>>;
  };
  fs: {
    listDir: (workspaceId: string, dirRelativePath: string) => Promise<Result<Array<{ name: string; relativePath: string; isDirectory: boolean; size: number; mtimeMs: number }>>>;
    rename: (workspaceId: string, targetRelativePath: string, newName: string) => Promise<Result<void>>;
    createFolder: (workspaceId: string, parentDirRelativePath: string, name: string) => Promise<Result<string>>;
    createFile: (workspaceId: string, parentDirRelativePath: string, name: string) => Promise<Result<string>>;
    move: (workspaceId: string, fromRelativePath: string, toRelativePath: string) => Promise<Result<void>>;
    delete: (workspaceId: string, targetRelativePath: string) => Promise<Result<{ trashRelativePath: string }>>;
    restore: (workspaceId: string, trashRelativePath: string, restoreToRelativePath: string) => Promise<Result<void>>;
    watchStart: (workspaceId: string) => Promise<Result<void>>;
    watchStop: (workspaceId: string) => Promise<Result<void>>;
    onEvent: (listener: (payload: { workspaceId: string; event: string; relativePath: string }) => void) => () => void;
  };
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    openWorkspace: (workspaceId: string) => Promise<Result<void>>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
