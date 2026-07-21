from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel

from agent.models import AgentError, ToolResult


_MAX_MODEL_CONTEXT_CHARS = 24_000
_MAX_FACTS = 20
_MAX_FACT_CHARS = 1_000
_SENSITIVE_KEYS = {
    "api_key", "apikey", "token", "authorization", "cookie", "password",
    "passwd", "secret", "credential", "private_key", "access_key",
    "proposed_content", "unified_diff",
}


def model_dump(value: BaseModel) -> dict[str, Any]:
    dump = getattr(value, "model_dump", None)
    return dump() if dump is not None else value.dict()


def utc_iso_z() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def event(event_type: str, run_id: str, **payload: Any) -> dict[str, Any]:
    if not event_type or not run_id:
        raise ValueError("event type and run_id are required")
    return {"type": event_type, "runId": run_id, **payload}


def _safe_model_value(value: Any, depth: int = 0) -> Any:
    if depth >= 6:
        return "[truncated]"
    if value is None or isinstance(value, (bool, int, str)):
        return value[:4_000] if isinstance(value, str) else value
    if isinstance(value, float):
        return value if value == value and abs(value) != float("inf") else None
    if isinstance(value, list):
        return [_safe_model_value(item, depth + 1) for item in value[:100]]
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in list(value.items())[:100]:
            key_text = str(key)[:100]
            if key_text.lower().replace("-", "_") in _SENSITIVE_KEYS:
                continue
            cleaned[key_text] = _safe_model_value(item, depth + 1)
        return cleaned
    return None


def tool_result_model_context(result: ToolResult) -> dict[str, Any]:
    raw = result.data if isinstance(result.data, dict) else {"value": result.data}
    facts_value = raw.get("facts") if isinstance(raw, dict) else None
    facts = [
        item.strip()[:_MAX_FACT_CHARS]
        for item in (facts_value if isinstance(facts_value, list) else [])[:_MAX_FACTS]
        if isinstance(item, str) and item.strip()
    ]
    structured = _safe_model_value({
        key: value for key, value in raw.items()
        if key not in {"facts", "sources"}
    })
    context = {"facts": facts, "structuredData": structured if isinstance(structured, dict) else {}}
    encoded = json.dumps(context, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(encoded) > _MAX_MODEL_CONTEXT_CHARS:
        context["structuredData"] = {"truncated": True}
    return context


def tool_result_event(
    run_id: str,
    *,
    step: int,
    step_id: str,
    call_id: str,
    result: ToolResult,
    duration_ms: int,
) -> dict[str, Any]:
    return event(
        "tool_result",
        run_id,
        step=step,
        stepId=step_id,
        callId=call_id,
        result={
            "tool": result.tool,
            "success": result.success,
            "status": "completed" if result.success else "failed",
            "uiSummary": result.summary[:1_000],
            "modelContext": tool_result_model_context(result),
            "durationMs": max(0, int(duration_ms)),
            "error": model_dump(result.error) if result.error is not None else None,
            "truncated": result.truncated,
        },
    )


def usage_event(
    run_id: str,
    *,
    operation_id: str,
    phase: str,
    provider: str,
    model: str,
    latency_ms: int,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cost: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "operationId": operation_id,
        "phase": phase,
        "provider": provider,
        "model": model,
        "latencyMs": max(0, int(latency_ms)),
    }
    if input_tokens is not None:
        payload["inputTokens"] = max(0, int(input_tokens))
    if output_tokens is not None:
        payload["outputTokens"] = max(0, int(output_tokens))
    if input_tokens is not None or output_tokens is not None:
        payload["totalTokens"] = max(0, int(input_tokens or 0) + int(output_tokens or 0))
    if cost is not None:
        payload["cost"] = cost
    return event("usage_updated", run_id, **payload)


def error_event(run_id: str, error: AgentError) -> dict[str, Any]:
    return event("error", run_id, error=model_dump(error))
