import asyncio
import json
import math
from collections.abc import Iterable
from typing import Any

from pydantic import ValidationError

from agent.models import AgentError, ToolResult
from agent.tools.base import (
    AgentTool,
    AgentToolContext,
    StrictToolArgs,
    validate_tool_args,
)
from schemas import DEFAULT_AGENT_TOOLS, ToolName


DEFAULT_MAX_OUTPUT_CHARS = 20_000
MAX_OUTPUT_NODES = 10_000
MAX_OUTPUT_DEPTH = 64
MAX_OUTPUT_STRING_CHARS = 100_000
VALID_TOOL_RISK_LEVELS = frozenset({"read", "write", "network", "terminal"})


def _validate_json_output(value: Any) -> None:
    """Validate an untrusted tool result with bounded, non-recursive traversal."""

    stack: list[tuple[Any, int, bool]] = [(value, 0, False)]
    ancestor_containers: set[int] = set()
    nodes = 0
    while stack:
        current, depth, exiting = stack.pop()
        if exiting:
            ancestor_containers.discard(id(current))
            continue

        nodes += 1
        if nodes > MAX_OUTPUT_NODES:
            raise ValueError("tool output exceeds node budget")
        if depth > MAX_OUTPUT_DEPTH:
            raise ValueError("tool output exceeds depth budget")

        if isinstance(current, dict):
            identity = id(current)
            if identity in ancestor_containers:
                raise ValueError("tool output contains a cycle")
            ancestor_containers.add(identity)
            stack.append((current, depth, True))
            if len(current) > MAX_OUTPUT_NODES - nodes:
                raise ValueError("tool output exceeds node budget")
            for key, item in current.items():
                if not isinstance(key, str) or len(key) > MAX_OUTPUT_STRING_CHARS:
                    raise ValueError("tool output contains an invalid key")
                stack.append((item, depth + 1, False))
        elif isinstance(current, list):
            identity = id(current)
            if identity in ancestor_containers:
                raise ValueError("tool output contains a cycle")
            ancestor_containers.add(identity)
            stack.append((current, depth, True))
            if len(current) > MAX_OUTPUT_NODES - nodes:
                raise ValueError("tool output exceeds node budget")
            stack.extend((item, depth + 1, False) for item in current)
        elif isinstance(current, str):
            if len(current) > MAX_OUTPUT_STRING_CHARS:
                raise ValueError("tool output string exceeds budget")
        elif current is None or isinstance(current, bool):
            continue
        elif isinstance(current, int):
            if current.bit_length() > 4096:
                raise ValueError("tool output integer exceeds budget")
        elif isinstance(current, float):
            if not math.isfinite(current):
                raise ValueError("tool output contains a non-finite number")
        else:
            raise TypeError("tool output contains a non-JSON value")

        if len(stack) > MAX_OUTPUT_NODES + MAX_OUTPUT_DEPTH:
            raise ValueError("tool output exceeds traversal budget")


def _serialize_json_output(value: Any, max_chars: int) -> tuple[str, bool]:
    _validate_json_output(value)
    encoder = json.JSONEncoder(
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )
    parts: list[str] = []
    size = 0
    for chunk in encoder.iterencode(value):
        remaining = max_chars - size
        if len(chunk) > remaining:
            if remaining > 0:
                parts.append(chunk[:remaining])
            return "".join(parts), True
        parts.append(chunk)
        size += len(chunk)
    return "".join(parts), False


class ToolRegistry:
    """Registry and policy boundary for validating and executing agent tools."""

    def __init__(
        self,
        *,
        allowed_tools: Iterable[ToolName] | None = None,
        max_output_chars: int = DEFAULT_MAX_OUTPUT_CHARS,
    ) -> None:
        if max_output_chars <= 0:
            raise ValueError("max_output_chars must be positive")
        self._tools: dict[ToolName, AgentTool] = {}
        self._default_policy = allowed_tools is None
        self._allowed_tools = set(DEFAULT_AGENT_TOOLS if allowed_tools is None else allowed_tools)
        self._max_output_chars = max_output_chars

    def register(self, tool: AgentTool) -> None:
        try:
            strict_args_model = issubclass(tool.args_model, StrictToolArgs)
        except TypeError:
            strict_args_model = False
        if not strict_args_model:
            raise ValueError("tool args_model must be a StrictToolArgs subclass")
        if (
            not isinstance(tool.risk_level, str)
            or tool.risk_level not in VALID_TOOL_RISK_LEVELS
        ):
            raise ValueError(
                "tool risk_level must be one of: read, write, network, terminal"
            )
        if tool.name in self._tools:
            raise ValueError(f"tool '{tool.name}' is already registered")
        self._tools[tool.name] = tool

    def list_tools(
        self,
        *,
        enabled_tools: Iterable[ToolName],
        allow_write: bool = False,
    ) -> list[AgentTool]:
        enabled = set(enabled_tools)
        return [
            tool
            for name, tool in self._tools.items()
            if name in enabled
            and self._policy_allows(tool)
            and (tool.risk_level != "write" or allow_write)
        ]

    def tool_schemas(
        self,
        *,
        enabled_tools: Iterable[ToolName],
        allow_write: bool = False,
    ) -> list[dict[str, Any]]:
        """Return provider-neutral schemas for tools allowed in this run."""
        schemas = []
        for tool in self.list_tools(enabled_tools=enabled_tools, allow_write=allow_write):
            model_json_schema = getattr(tool.args_model, "model_json_schema", None)
            parameters = model_json_schema() if model_json_schema else tool.args_model.schema()
            schemas.append({
                "name": tool.name,
                "description": tool.description,
                "parameters": parameters,
            })
        return schemas

    async def execute(
        self,
        tool_name: str,
        context: AgentToolContext,
        arguments: Any,
        *,
        enabled_tools: Iterable[ToolName],
        allow_write: bool = False,
        tool_timeout_seconds: int | float | None = None,
    ) -> ToolResult:
        tool = self._tools.get(tool_name)
        if tool is None:
            return self._failure(
                tool_name,
                "tool_not_found",
                "The requested tool is not registered.",
                "Tool execution failed because the tool is unknown.",
            )
        if tool_name not in set(enabled_tools):
            return self._failure(
                tool_name,
                "tool_not_enabled",
                "The requested tool is not enabled for this request.",
                "Tool execution was blocked because the tool is not enabled.",
            )
        if not self._policy_allows(tool):
            return self._failure(
                tool_name,
                "tool_policy_denied",
                "The requested tool is not allowed by policy.",
                "Tool execution was blocked by policy.",
            )
        if tool.risk_level == "write" and not allow_write:
            return self._failure(
                tool_name,
                "tool_write_not_allowed",
                "The requested write operation was not authorized for this request.",
                "Tool execution was blocked because write access was not authorized.",
            )

        try:
            validated_args = validate_tool_args(tool.args_model, arguments)
        except (ValidationError, TypeError, ValueError) as exc:
            return self._failure(
                tool_name,
                "tool_invalid_arguments",
                "The tool arguments are invalid.",
                "Tool execution failed because its arguments are invalid.",
                technical_detail=type(exc).__name__,
            )

        try:
            operation = tool.execute(context, validated_args)
            data = (
                await operation
                if tool_timeout_seconds is None
                else await asyncio.wait_for(operation, timeout=tool_timeout_seconds)
            )
        except ValueError as exc:
            return self._failure(
                tool_name,
                "tool_invalid_arguments",
                "The tool arguments are invalid.",
                "Tool execution failed because its arguments are invalid.",
                technical_detail=type(exc).__name__,
            )
        except asyncio.TimeoutError:
            return self._failure(
                tool_name,
                "tool_timeout",
                "工具执行超时，请稍后重试或缩小请求范围。",
                "Tool execution timed out.",
                technical_detail=f"timeout after {tool_timeout_seconds} seconds",
                retryable=True,
            )
        except Exception as exc:
            return self._failure(
                tool_name,
                "tool_execution_failed",
                "The tool failed during execution.",
                "Tool execution failed.",
                technical_detail=type(exc).__name__,
            )

        try:
            serialized, truncated = _serialize_json_output(data, self._max_output_chars)
        except Exception as exc:
            return self._failure(
                tool_name,
                "tool_execution_failed",
                "The tool returned an invalid result that could not be processed.",
                "Tool execution failed because its result could not be processed.",
                technical_detail=type(exc).__name__,
            )
        if truncated:
            return ToolResult(
                tool=tool_name,
                success=True,
                summary=(
                    "Tool execution completed; output was truncated to "
                    f"{self._max_output_chars} characters."
                ),
                data=serialized,
                truncated=True,
            )
        return ToolResult(
            tool=tool_name,
            success=True,
            summary="Tool execution completed successfully.",
            data=data,
        )

    def _policy_allows(self, tool: AgentTool) -> bool:
        if tool.name not in self._allowed_tools:
            return False
        return not self._default_policy or tool.risk_level == "read"

    @staticmethod
    def _failure(
        tool_name: str,
        code: str,
        message: str,
        summary: str,
        *,
        technical_detail: str | None = None,
        retryable: bool = False,
    ) -> ToolResult:
        return ToolResult(
            tool=tool_name or "<unknown>",
            success=False,
            summary=summary,
            error=AgentError(
                code=code,
                message=message,
                technical_detail=technical_detail,
                retryable=retryable,
            ),
        )
