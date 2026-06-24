from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


ProviderType = Literal[
    "ollama",
    "openai",
    "openai-compatible",
    "deepseek",
    "qwen",
    "custom",
]


class ChatModelConfig(BaseModel):
    provider: ProviderType
    model: str = Field(..., min_length=1)
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    temperature: float = Field(default=0.7, ge=0, le=2)
    max_tokens: Optional[int] = Field(default=None, gt=0)


class EmbeddingModelConfig(BaseModel):
    provider: ProviderType
    model: str = Field(..., min_length=1)
    base_url: Optional[str] = None
    api_key: Optional[str] = None
    dimension: Optional[int] = Field(default=None, gt=0)


class AIConfig(BaseModel):
    chat: ChatModelConfig
    # 普通聊天不一定需要 embedding，但 RAG 查询和索引接口会强制检查它存在。
    embedding: Optional[EmbeddingModelConfig] = None


class WorkspaceContext(BaseModel):
    workspace_path: str = Field(..., min_length=1)


class KnowledgeConfig(BaseModel):
    vector_store_path: str = ".looma/rag-index"
    top_k: int = Field(default=5, gt=0, le=50)
    include_sources: bool = True
    rerank: bool = False
    chunk_size: int = Field(default=800, ge=128, le=8192)
    chunk_overlap: int = Field(default=100, ge=0, le=2048)


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str = Field(..., min_length=1)
    name: Optional[str] = None


class RequestStats(BaseModel):
    history_messages: int = Field(default=0, ge=0)
    history_token_estimate: int = Field(default=0, ge=0)
    question_token_estimate: int = Field(default=0, ge=0)
    total_token_estimate: int = Field(default=0, ge=0)


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1)
    ai_config: Optional[AIConfig] = None
    history: list[ChatMessage] = Field(default_factory=list)
    request_stats: Optional[RequestStats] = None


class RagQueryRequest(BaseModel):
    question: str = Field(..., min_length=1)
    workspace: WorkspaceContext
    knowledge: Optional[KnowledgeConfig] = None
    ai_config: Optional[AIConfig] = None
    history: list[ChatMessage] = Field(default_factory=list)
    request_stats: Optional[RequestStats] = None


class IndexRequest(BaseModel):
    workspace: WorkspaceContext
    knowledge: Optional[KnowledgeConfig] = None
    ai_config: Optional[AIConfig] = None


class IndexStatusRequest(BaseModel):
    workspace_path: str = Field(..., min_length=1)
    vector_store_path: Optional[str] = None


AgentMode = Literal["chat", "rag", "agent"]

IndexBuildMode = Literal["incremental", "full", "retry_failed"]


class IndexBuildRequest(BaseModel):
    workspace: WorkspaceContext
    mode: IndexBuildMode = "incremental"
    path: Optional[str] = None
    knowledge: Optional[KnowledgeConfig] = None
    ai_config: Optional[AIConfig] = None

ToolName = Literal[
    "rag_search",
    "file_read",
    "file_write",
    "workspace_search",
    "web_search",
    "terminal",
]


class ToolConfig(BaseModel):
    name: ToolName
    enabled: bool = True
    config: dict[str, Any] = Field(default_factory=dict)


class AgentConfig(BaseModel):
    mode: AgentMode = "agent"
    tools: list[ToolConfig] = Field(default_factory=list)
    max_steps: int = Field(default=8, gt=0, le=50)
    stream_steps: bool = True
    allow_write: bool = False


class AgentRunRequest(BaseModel):
    input: str = Field(..., min_length=1)
    workspace: Optional[WorkspaceContext] = None
    knowledge: Optional[KnowledgeConfig] = None
    ai_config: Optional[AIConfig] = None
    agent: AgentConfig = Field(default_factory=AgentConfig)
    history: list[ChatMessage] = Field(default_factory=list)
