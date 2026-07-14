from typing import Annotated, Any, Literal, Optional, Union

from pydantic import BaseModel, Field, root_validator, validator

from schemas import ToolName


class StrictAgentModel(BaseModel):
    """Reject protocol drift instead of silently discarding unknown fields."""

    class Config:
        extra = "forbid"


class AgentToolCall(StrictAgentModel):
    type: Literal["tool_call"]
    thought_summary: str = Field(..., min_length=1, max_length=500)
    tool: ToolName
    arguments: dict[str, Any]

    @validator("thought_summary", pre=True)
    def normalize_thought_summary(cls, value: Any) -> Any:
        if not isinstance(value, str):
            return value
        value = value.strip()
        if not value:
            raise ValueError("thought_summary must not be blank")
        return value


class AgentFinalAnswer(StrictAgentModel):
    type: Literal["final"]
    answer: str = Field(..., min_length=1)


AgentDecision = Annotated[
    Union[AgentToolCall, AgentFinalAnswer],
    Field(discriminator="type"),
]


class AgentError(StrictAgentModel):
    code: str = Field(..., min_length=1)
    message: str = Field(..., min_length=1)
    technical_detail: Optional[str] = None
    retryable: bool = False


class ToolResult(StrictAgentModel):
    tool: str = Field(..., min_length=1)
    success: bool
    summary: str = Field(..., min_length=1)
    data: Any = None
    error: Optional[AgentError] = None
    truncated: bool = False

    @root_validator(skip_on_failure=True)
    def validate_error_matches_success(cls, values: dict[str, Any]) -> dict[str, Any]:
        success = values.get("success")
        error = values.get("error")
        if success is False and error is None:
            raise ValueError("error is required when success is false")
        if success is True and error is not None:
            raise ValueError("error must be absent when success is true")
        return values


def parse_agent_decision(value: Any) -> AgentDecision:
    """Validate an untrusted model response as one canonical decision."""

    try:
        from pydantic import TypeAdapter
    except ImportError:  # Pydantic v1
        from pydantic import parse_obj_as

        return parse_obj_as(AgentDecision, value)

    return TypeAdapter(AgentDecision).validate_python(value)
