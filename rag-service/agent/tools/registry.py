import json
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
VALID_TOOL_RISK_LEVELS = frozenset({"read", "write", "network", "terminal"})


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

    async def execute(
        self,
        tool_name: str,
        context: AgentToolContext,
        arguments: Any,
        *,
        enabled_tools: Iterable[ToolName],
        allow_write: bool = False,
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
                technical_detail=str(exc),
            )

        try:
            data = await tool.execute(context, validated_args)
        except Exception as exc:
            return self._failure(
                tool_name,
                "tool_execution_failed",
                "The tool failed during execution.",
                "Tool execution failed.",
                technical_detail=f"{type(exc).__name__}: {exc}",
            )

        try:
            serialized = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        except Exception as exc:
            return self._failure(
                tool_name,
                "tool_execution_failed",
                "The tool returned an invalid result that could not be processed.",
                "Tool execution failed because its result could not be processed.",
                technical_detail=f"{type(exc).__name__}: {exc}",
            )
        if len(serialized) > self._max_output_chars:
            return ToolResult(
                tool=tool_name,
                success=True,
                summary=(
                    "Tool execution completed; output was truncated to "
                    f"{self._max_output_chars} characters."
                ),
                data=serialized[: self._max_output_chars],
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
    ) -> ToolResult:
        return ToolResult(
            tool=tool_name or "<unknown>",
            success=False,
            summary=summary,
            error=AgentError(
                code=code,
                message=message,
                technical_detail=technical_detail,
            ),
        )
