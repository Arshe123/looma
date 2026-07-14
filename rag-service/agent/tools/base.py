from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Type

from pydantic import BaseModel

from schemas import AIConfig, KnowledgeConfig, ToolName


ToolRiskLevel = Literal["read", "write", "network", "terminal"]


class StrictToolArgs(BaseModel):
    """Base for tool arguments that rejects undeclared input fields."""

    class Config:
        extra = "forbid"


@dataclass(frozen=True)
class AgentToolContext:
    """Execution context shared by tools without coupling them to the runtime."""

    workspace_path: Path | str
    ai_config: AIConfig | None = None
    knowledge: KnowledgeConfig | None = None


class AgentTool(ABC):
    """Small extension point implemented by concrete agent tools."""

    name: ToolName
    description: str
    risk_level: ToolRiskLevel
    args_model: Type[StrictToolArgs]

    @abstractmethod
    async def execute(self, context: AgentToolContext, args: StrictToolArgs) -> Any:
        """Execute with validated arguments and return JSON-serializable data."""


def validate_tool_args(model: Type[StrictToolArgs], value: Any) -> StrictToolArgs:
    """Validate arguments with either Pydantic v1 or v2."""

    model_validate = getattr(model, "model_validate", None)
    if model_validate is not None:
        return model_validate(value)
    return model.parse_obj(value)


def dump_tool_args(value: BaseModel) -> dict[str, Any]:
    """Dump validated arguments with either Pydantic v1 or v2."""

    model_dump = getattr(value, "model_dump", None)
    if model_dump is not None:
        return model_dump()
    return value.dict()
