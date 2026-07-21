from __future__ import annotations

import json
from typing import Any

from agent.events import tool_result_model_context
from agent.models import AgentToolCall, ToolResult

MAX_OBSERVATION_CHARS = 12_000


def decision_prompt(decision: AgentToolCall) -> str:
    payload = {
        "type": "tool_call",
        "thought_summary": decision.thought_summary,
        "tool": decision.tool,
        "arguments": decision.arguments,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def observation_prompt(result: ToolResult, max_chars: int = MAX_OBSERVATION_CHARS) -> str:
    error = None
    if result.error is not None:
        error = {
            "code": result.error.code,
            "message": result.error.message,
            "retryable": result.error.retryable,
        }
    base: dict[str, Any] = {
        "tool": result.tool,
        "success": result.success,
        "modelContext": tool_result_model_context(result),
        "error": error,
        "truncated": result.truncated,
    }
    rendered = json.dumps(base, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(rendered) <= max_chars:
        return rendered

    base["modelContext"] = {"facts": [], "structuredData": {"truncated": True}}
    base["truncated"] = True
    compact = json.dumps(base, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(compact) <= max_chars:
        return compact
    return '{"truncated":true}'


def final_only_prompt() -> str:
    return (
        "已达到本次运行允许的最大工具步数。不得再调用工具。"
        "请仅基于已有对话与工具观察返回 final 决策和最终答案。"
    )
