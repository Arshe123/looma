from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, root_validator, validator


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
    embedding: Optional[EmbeddingModelConfig] = None


class WorkspaceContext(BaseModel):
    workspace_path: str = Field(..., min_length=1)


ChunkingStrategy = Literal["fixed", "markdown", "semantic", "parent_child", "code_aware"]


class KnowledgeConfig(BaseModel):
    vector_store_path: str = ".looma/rag-index"
    top_k: int = Field(default=5, gt=0, le=50)
    include_sources: bool = True
    rerank: bool = False
    chunk_size: int = Field(default=800, ge=128, le=8192)
    chunk_overlap: int = Field(default=100, ge=0, le=2048)
    chunking_strategy: ChunkingStrategy = "fixed"


class ChatToolFunction(BaseModel):
    name: str = Field(..., min_length=1)
    arguments: dict[str, Any]


class ChatToolCall(BaseModel):
    id: str = Field(..., min_length=1)
    type: Literal["function"] = "function"
    function: ChatToolFunction


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: Optional[str] = None
    name: Optional[str] = None
    tool_calls: Optional[list[ChatToolCall]] = None
    tool_call_id: Optional[str] = None
    reasoning_content: Optional[str] = None

    @root_validator(skip_on_failure=True)
    def validate_role_shape(cls, values: dict[str, Any]) -> dict[str, Any]:
        role = values.get("role")
        content = values.get("content")
        tool_calls = values.get("tool_calls")
        if role == "assistant":
            if not ((isinstance(content, str) and content.strip()) or tool_calls):
                raise ValueError("assistant message requires content or tool_calls")
        elif not isinstance(content, str) or not content.strip():
            raise ValueError(f"{role} message requires content")
        if role == "tool" and not values.get("tool_call_id"):
            raise ValueError("tool message requires tool_call_id")
        return values


class RequestStats(BaseModel):
    history_messages: int = Field(default=0, ge=0)
    history_token_estimate: int = Field(default=0, ge=0)
    question_token_estimate: int = Field(default=0, ge=0)
    total_token_estimate: int = Field(default=0, ge=0)
    recent_turns: int = Field(default=0, ge=0)
    distant_summary_enabled: bool = False
    distant_summary_messages: int = Field(default=0, ge=0)


class AgentSummarizeRequest(BaseModel):
    messages: list[ChatMessage] = Field(..., min_items=1, max_items=100)
    max_chars: int = Field(default=1600, ge=200, le=8000)

    class Config:
        extra = "forbid"


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


IndexBuildMode = Literal["incremental", "full", "retry_failed"]


class IndexBuildRequest(BaseModel):
    workspace: WorkspaceContext
    mode: IndexBuildMode = "incremental"
    path: Optional[str] = None
    knowledge: Optional[KnowledgeConfig] = None
    ai_config: Optional[AIConfig] = None

ToolName = Literal[
    "rag_search",
    "workspace_list",
    "workspace_search",
    "file_read",
    "file_patch",
    "web_search",
    "terminal",
]

DEFAULT_AGENT_TOOLS: tuple[ToolName, ...] = (
    "rag_search",
    "workspace_list",
    "workspace_search",
    "file_read",
    "file_patch",
)


class StrictAgentModel(BaseModel):
    """Agent contract models reject unknown fields in Pydantic v1 and v2."""

    class Config:
        extra = "forbid"


class ToolConfig(StrictAgentModel):
    name: ToolName
    enabled: bool = True
    config: dict[str, Any] = Field(default_factory=dict)


class AgentConfig(StrictAgentModel):
    enabled_tools: list[ToolName] = Field(default_factory=lambda: list(DEFAULT_AGENT_TOOLS))
    max_steps: int = Field(default=90, gt=0, le=100)
    tool_timeout_seconds: int = Field(default=30, gt=0, le=300)
    run_timeout_seconds: int = Field(default=300, gt=0, le=1800)
    allow_write: bool = False


class AgentRunRequest(StrictAgentModel):
    input: str = Field(..., min_length=1)
    task_id: str = Field(..., min_length=1, max_length=128)
    run_id: str = Field(..., min_length=1, max_length=128)
    parent_run_id: Optional[str] = Field(default=None, max_length=128)
    recovery_reason: Optional[Literal[
        "app_restart",
        "service_restart",
        "provider_interrupted",
        "approval_continuation",
        "manual_retry",
    ]] = None
    workspace: Optional[WorkspaceContext] = None
    knowledge: Optional[KnowledgeConfig] = None
    ai_config: Optional[AIConfig] = None
    agent: AgentConfig = Field(default_factory=AgentConfig)
    history: list[ChatMessage] = Field(default_factory=list)

    @validator("task_id", "run_id", "parent_run_id")
    def validate_agent_identifier(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        if not value.replace("_", "").replace("-", "").isalnum():
            raise ValueError("invalid Agent identifier")
        return value

    @root_validator(skip_on_failure=True)
    def validate_continuation(cls, values: dict[str, Any]) -> dict[str, Any]:
        parent_run_id = values.get("parent_run_id")
        recovery_reason = values.get("recovery_reason")
        if bool(parent_run_id) != bool(recovery_reason):
            raise ValueError("parent_run_id and recovery_reason must be provided together")
        if parent_run_id and parent_run_id == values.get("run_id"):
            raise ValueError("continuation run_id must differ from parent_run_id")
        return values


class AgentApprovalResolveRequest(StrictAgentModel):
    approval_id: str = Field(..., min_length=1)
    status: Literal["approved", "rejected"]
    reason: Optional[str] = None
    applied: Optional[bool] = None
