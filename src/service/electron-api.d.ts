import type { Result } from '../common/interface/Result'

type SidebarPanelId = 'files' | 'outline' | 'ai';

interface SidebarPanelState {
  id: SidebarPanelId;
  size: number;
}

type AiAssistantMessageRole = 'assistant' | 'user' | 'system';

interface AiAssistantMessagePayload {
  id: number;
  role: AiAssistantMessageRole;
  text: string;
  createdAt: number;
  actions?: AiAssistantMessageActionPayload[];
}

interface AiAssistantMessageActionPayload {
  type: 'build-index';
  title: string;
  description: string;
  buttonText: string;
  disabled?: boolean;
}

interface AiAssistantStatePayload {
  conversations: AiAssistantConversationPayload[];
  activeConversationId: string;
}

interface AiAssistantConversationPayload {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: AiAssistantMessagePayload[];
  draft: string;
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

interface RagSourcePayload {
  score: number | null;
  text: string;
  metadata: Record<string, unknown>;
}

interface RagAnswerPayload {
  answer: string;
  sources: RagSourcePayload[];
}

interface RagIndexPayload {
  status: string;
  document_count?: number;
  exists?: boolean;
  persist_dir?: string;
  error?: string;
}

interface RagIndexStatusPayload {
  exists: boolean;
  persist_dir?: string;
  error?: string;
}

type RagStreamEventPayload =
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'sources'; sources: RagSourcePayload[] }
  | { requestId: string; type: 'done' }
  | { requestId: string; type: 'error'; error: string };

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
  workspaceAi: {
    get: (workspaceId: string) => Promise<Result<AiAssistantStatePayload>>;
    set: (workspaceId: string, state: AiAssistantStatePayload) => Promise<Result<void>>;
  };
  appSettings: {
    get: () => Promise<Result<AppSettingsPayload>>;
    set: (settings: AppSettingsPayload) => Promise<Result<void>>;
  };
  rag: {
    health: () => Promise<Result<{ status: string; service: string }>>;
    status: (workspaceId: string) => Promise<Result<RagIndexStatusPayload>>;
    index: (workspaceId: string) => Promise<Result<RagIndexPayload>>;
    ask: (workspaceId: string, question: string) => Promise<Result<RagAnswerPayload>>;
    askStream: {
      start: (requestId: string, workspaceId: string, question: string) => Promise<Result<void>>;
      cancel: (requestId: string) => Promise<Result<void>>;
      onEvent: (listener: (payload: RagStreamEventPayload) => void) => () => void;
    };
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
