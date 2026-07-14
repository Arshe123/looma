import type { Result } from '../shared/types/Result'
import type { AppSettings as AppSettingsPayload } from '../shared/utils/app-settings'

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
  aiName?: string;
  actions?: AiAssistantMessageActionPayload[];
  timeline?: AiAssistantTimelineStepPayload[];
  runId?: string;
  mode?: 'rag' | 'agent';
  modelIdentity?: { provider: string; model: string; displayName: string };
  agentSummary?: {
    status: 'running' | 'completed' | 'cancelled' | 'error';
    toolCallCount?: number;
    sourceCount?: number;
    error?: { message: string; technicalDetail?: string };
  };
}

interface AiAssistantMessageActionPayload {
  type: 'build-index';
  title: string;
  description: string;
  buttonText: string;
  disabled?: boolean;
}

type AiAssistantTimelineStepStatusPayload = 'pending' | 'active' | 'completed' | 'error';
type AiAssistantTimelineOutputTypePayload = 'text' | 'source' | 'metric' | 'code' | 'json' | 'error';

interface AiAssistantTimelineOutputPayload {
  id: string;
  type: AiAssistantTimelineOutputTypePayload;
  title?: string;
  content?: string;
  value?: string | number;
  unit?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

interface AiAssistantTimelineStepPayload {
  id: string;
  title: string;
  description?: string;
  detail?: string;
  status: AiAssistantTimelineStepStatusPayload;
  startedAt: number;
  endedAt?: number;
  outputs: AiAssistantTimelineOutputPayload[];
}

interface AiAssistantStatePayload {
  conversations: AiAssistantConversationPayload[];
  activeConversationId: string | null;
  temporaryDraft?: string;
  isTemporaryConversation?: boolean;
}

interface AiAssistantConversationPayload {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: AiAssistantMessagePayload[];
  draft: string;
  archived?: boolean;
  archivedAt?: number;
  pinned?: boolean;
  pinnedAt?: number;
  favorite?: boolean;
  favoriteCategory?: string;
  titleEdited?: boolean;
}

interface WorkspaceTabPayloadBase {
  id: string;
}

interface FileWorkspaceTabPayload extends WorkspaceTabPayloadBase {
  kind: 'file';
  relativePath: string;
}

interface SystemWorkspaceTabPayload extends WorkspaceTabPayloadBase {
  kind: 'system';
  page: 'settings' | 'rag-index' | 'ai-history';
}

type WorkspaceTabPayload = FileWorkspaceTabPayload | SystemWorkspaceTabPayload;

interface WorkspaceMetaPayload {
  expandedDirs: string[];
  selectedPaths: string[];
  noteOrder: Record<string, string[]>;
  openedFiles?: string[];
  activeFile?: string;
  tabs?: WorkspaceTabPayload[];
  activeTabId?: string;
  fileSessions?: Record<string, any>;
  activeSidebarPanel?: SidebarPanelId | null;
  sidebarPanels?: SidebarPanelState[];
}

interface RagChatMessagePayload {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
}

interface RagRequestStatsPayload {
  history_messages: number;
  history_token_estimate: number;
  question_token_estimate: number;
  total_token_estimate: number;
  recent_turns?: number;
  distant_summary_enabled?: boolean;
  distant_summary_messages?: number;
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
  file_count?: number;
  exists?: boolean;
  persist_dir?: string;
  embedding_model?: string;
  embedding_provider?: string;
  error?: string;
}

interface RagIndexSummaryPayload {
  indexed: number;
  notIndexed: number;
  outdated: number;
  deleted: number;
  failed: number;
  ignored: number;
}

interface RagIndexCompatibilityPayload {
  compatible: boolean;
  needRebuild: boolean;
  reason: string;
}

interface RagIndexFileStatusPayload {
  path: string;
  status: 'indexed' | 'not_indexed' | 'outdated' | 'deleted' | 'failed' | 'ignored';
  contentHash?: string;
  mtimeMs?: number;
  size?: number;
  chunkIds?: string[];
  chunkCount?: number;
  lastIndexedAt?: string | null;
  error?: string | null;
}

interface RagFileChunkPayload {
  id: string;
  index: number;
  text: string;
  textLength?: number;
  metadata: Record<string, unknown>;
  filePath?: string;
}

interface RagFileChunksPayload {
  status: string;
  path: string;
  chunkCount: number;
  chunks: RagFileChunkPayload[];
  manifest?: RagIndexFileStatusPayload | null;
  persist_dir?: string;
  requiresRebuild?: boolean;
  error?: string;
}

interface RagIndexStatusPayload {
  exists: boolean;
  persist_dir?: string;
  error?: string;
  workspaceId?: string;
  indexCompatible?: boolean;
  needRebuild?: boolean;
  compatibility?: RagIndexCompatibilityPayload;
  summary?: RagIndexSummaryPayload;
  files?: RagIndexFileStatusPayload[];
  metadata?: Record<string, unknown> | null;
}

type RagStreamEventPayload =
  | { requestId: string; type: 'timeline'; stepId?: string; status?: AiAssistantTimelineStepStatusPayload; title?: string; description?: string; detail?: string; outputs?: Partial<AiAssistantTimelineOutputPayload>[]; step?: Partial<AiAssistantTimelineStepPayload> & { stepId?: string } }
  | { requestId: string; type: 'progress'; stepId: string; current: number; total?: number; message?: string }
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'sources'; sources: RagSourcePayload[] }
  | { requestId: string; type: 'done'; result?: RagIndexPayload; status?: string; document_count?: number; file_count?: number; exists?: boolean; persist_dir?: string }
  | { requestId: string; type: 'error'; error: string; stepId?: string };

type AgentToolNamePayload = 'rag_search' | 'workspace_list' | 'workspace_search' | 'file_read';
interface AgentRunOptionsPayload {
  input: string;
  history?: RagChatMessagePayload[];
  enabledTools?: AgentToolNamePayload[];
  maxSteps?: number;
  toolTimeoutSeconds?: number;
  runTimeoutSeconds?: number;
}
interface AgentErrorPayload {
  code: string;
  message: string;
  technical_detail?: string | null;
  retryable: boolean;
}
type AgentStreamEventPayload =
  | { requestId: string; type: 'run_started'; runId: string; startedAt: string }
  | { requestId: string; type: 'timeline'; runId: string; step: number; stepId: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; summary: string }
  | { requestId: string; type: 'tool_call'; runId: string; step: number; stepId: string; callId: string; tool: AgentToolNamePayload; arguments: Record<string, unknown>; thought_summary: string }
  | { requestId: string; type: 'tool_result'; runId: string; step: number; stepId: string; callId: string; result: Record<string, unknown> }
  | { requestId: string; type: 'sources'; runId: string; sources: Array<Record<string, unknown>> }
  | { requestId: string; type: 'delta'; runId: string; text: string; content: string }
  | { requestId: string; type: 'done'; runId: string; status: 'completed' | 'cancelled'; answer?: string }
  | { requestId: string; type: 'error'; runId: string; error: AgentErrorPayload };

interface OllamaDownloadProgressPayload {
  status: 'downloading' | 'completed' | 'error' | 'cancelled';
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
  error?: string;
}

interface OllamaModelPullProgressPayload extends OllamaDownloadProgressPayload {
  model: string;
  message?: string;
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
    getVersion: () => Promise<string>;
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
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
  ollama: {
    listModels: (baseUrl: string) => Promise<Result<{ models: string[] }>>;
    checkInstalled: (baseUrl: string) => Promise<Result<{ installed: boolean; version?: string }>>;
    downloadInstaller: () => Promise<Result<{ installerPath: string }>>;
    cancelDownload: () => Promise<Result<void>>;
    pullModel: (baseUrl: string, model: string) => Promise<Result<void>>;
    cancelPullModel: (model: string) => Promise<Result<void>>;
    deleteModel: (baseUrl: string, model: string) => Promise<Result<void>>;
    onDownloadProgress: (listener: (payload: OllamaDownloadProgressPayload) => void) => () => void;
    onPullModelProgress: (listener: (payload: OllamaModelPullProgressPayload) => void) => () => void;
  };
  rag: {
    health: () => Promise<Result<{ status: string; service: string }>>;
    status: (workspaceId: string) => Promise<Result<RagIndexStatusPayload>>;
    chat: (workspaceId: string, question: string, history?: RagChatMessagePayload[], requestStats?: RagRequestStatsPayload) => Promise<Result<RagAnswerPayload>>;
    summarizeConversation: (messages: RagChatMessagePayload[], maxChars: number) => Promise<Result<{ answer: string }>>;
    askStream: {
      start: (requestId: string, workspaceId: string, question: string, history?: RagChatMessagePayload[], requestStats?: RagRequestStatsPayload) => Promise<Result<void>>;
      cancel: (requestId: string) => Promise<Result<void>>;
      onEvent: (listener: (payload: RagStreamEventPayload) => void) => () => void;
    };
    indexStream: {
      start: (requestId: string, workspaceId: string, mode?: 'incremental' | 'full' | 'retry_failed') => Promise<Result<void>>;
      cancel: (requestId: string) => Promise<Result<void>>;
      onEvent: (listener: (payload: RagStreamEventPayload) => void) => () => void;
    };
    indexFile: {
      reindex: (workspaceId: string, relativePath: string) => Promise<Result<RagIndexPayload>>;
      chunks: (workspaceId: string, relativePath: string) => Promise<Result<RagFileChunksPayload>>;
      delete: (workspaceId: string, relativePath: string) => Promise<Result<RagIndexPayload>>;
    };
    deleteIndex: (workspaceId: string) => Promise<Result<void>>;
  };
  agent: {
    runStream: {
      start: (requestId: string, workspaceId: string, options: AgentRunOptionsPayload) => Promise<Result<void>>;
      cancel: (requestId: string) => Promise<Result<void>>;
      onEvent: (listener: (payload: AgentStreamEventPayload) => void) => () => void;
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
