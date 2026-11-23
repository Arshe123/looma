from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from agent.models import AgentError, ToolResult


_MAX_MODEL_CONTEXT_CHARS = 24_000
_MAX_FACTS = 20
_MAX_FACT_CHARS = 1_000
_SENSITIVE_KEYS = {
    "api_key", "apikey", "token", "authorization", "cookie", "password",
    "passwd", "secret", "credential", "private_key", "access_key",
    "proposed_content", "unified_diff",
}


def utc_iso_z() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def event(event_type: str, run_id: str, **payload: Any) -> dict[str, Any]:
    if not event_type or not run_id:
        raise ValueError("event type and run_id are required")
    return {"type": event_type, "runId": run_id, **payload}


def _safe_model_value(value: Any, depth: int = 0, *, clipped: list[bool] | None = None) -> Any:
    if clipped is None:
        clipped = [False]
    if depth >= 6:
        clipped[0] = True
        return "[truncated]"
    if value is None or isinstance(value, (bool, int, str)):
        if isinstance(value, str) and len(value) > 4_000:
            clipped[0] = True
            return value[:4_000] + "[truncated]"
        return value
    if isinstance(value, float):
        return value if value == value and abs(value) != float("inf") else None
    if isinstance(value, list):
        clipped[0] |= len(value) > 100
        return [_safe_model_value(item, depth + 1, clipped=clipped) for item in value[:100]]
    if isinstance(value, dict):
        clipped[0] |= len(value) > 100
        cleaned: dict[str, Any] = {}
        for key, item in list(value.items())[:100]:
            key_text = str(key)[:100]
            if key_text.lower().replace("-", "_") in _SENSITIVE_KEYS:
                continue
            clipped[0] |= len(str(key)) > 100
            cleaned[key_text] = _safe_model_value(item, depth + 1, clipped=clipped)
        return cleaned
    return None


def _encoded_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False))


def bounded_rag_data(raw: dict[str, Any], max_chars: int) -> dict[str, Any]:
    """Retain ranked text and citation metadata rather than a count-only result."""
    clipping = [False]
    data = _safe_model_value({key: raw[key] for key in (
        "status", "query", "count", "message", "requiresRebuild", "truncated",
    ) if key in raw}, clipped=clipping)
    sources = []
    raw_sources = raw.get("sources", [])
    clipped = raw.get("truncated") is True or len(raw_sources) > 50
    for item in raw_sources[:50]:
        if not isinstance(item, dict):
            clipped = True
            continue
        source = _safe_model_value(item, clipped=clipping)
        metadata = source.get("metadata")
        if isinstance(metadata, dict) and _encoded_size(metadata) > 2_000:
            # Reader-specific metadata can be arbitrarily large. Prefer citation
            # fields, selected before sanitization so a late path isn't lost.
            raw_metadata = item.get("metadata", {})
            source["metadata"] = _safe_model_value({
                key: raw_metadata[key] for key in (
                    "path", "source", "file_path", "file_name", "page_label", "page",
                    "title", "start_line", "end_line",
                ) if key in raw_metadata
            }, clipped=clipping)
            source["metadataTruncated"] = True
            clipped = True
        text = item.get("text", "")
        if isinstance(text, str) and len(text) > 4_000:
            source["textTruncated"] = True
            clipped = True
        sources.append(source)
    data["sources"] = sources
    data["returnedSourceCount"] = len(sources)
    if clipped or clipping[0]:
        data["truncated"] = True
    while _encoded_size(data) > max_chars and len(sources) > 1:
        sources.pop()
        data.update(truncated=True, returnedSourceCount=len(sources))
    # A very large first chunk/metadata must not discard the entire observation.
    # Reduce the largest string leaf with a visible marker; keep the source shape.
    while _encoded_size(data) > max_chars:
        candidates: list[tuple[dict[str, Any], str]] = []

        def collect(value: Any) -> None:
            if isinstance(value, dict):
                for key, child in value.items():
                    if isinstance(child, str) and len(child) > 64:
                        candidates.append((value, key))
                    elif isinstance(child, (dict, list)):
                        collect(child)
            elif isinstance(value, list):
                for child in value:
                    collect(child)

        collect(data)
        if not candidates:
            return {"truncated": True}
        parent, key = max(candidates, key=lambda pair: len(pair[0][pair[1]]))
        parent[key] = parent[key][:len(parent[key]) // 2] + "[truncated]"
        if key == "text":
            parent["textTruncated"] = True
        data["truncated"] = True
    return data


def bounded_file_read_data(raw: dict[str, Any], max_chars: int) -> dict[str, Any]:
    """Keep a valid file observation, including the position after its prefix.

    nextStartColumn is one-based. To resume a partial line with file_read,
    re-read nextStartLine with a larger max_chars; it is not a column argument.
    Budgets count JSON-encoded characters (including escaped newlines).
    """
    content = raw.get("content", "")
    if not isinstance(content, str):
        content = ""
    available_chars = raw.get("availableContentChars")
    if not isinstance(available_chars, int) or isinstance(available_chars, bool) or available_chars < len(content):
        available_chars = len(content)
    data = _safe_model_value({key: value for key, value in raw.items() if key != "content"})
    start = raw.get("startLine", 1)
    if not isinstance(start, int) or isinstance(start, bool):
        start = 1

    def prefix(length: int) -> dict[str, Any]:
        text = content[:length]
        bounded = {**data, "content": text}
        if length < len(content) or raw.get("truncated") is True:
            bounded.update(
                truncated=True,
                availableContentChars=available_chars,
                returnedChars=len(text),
                endLine=(start + text.count("\n") - int(text.endswith("\n"))) if text else 0,
                nextStartLine=start + text.count("\n"),
                nextStartColumn=len(text.rsplit("\n", 1)[-1]) + 1,
            )
        return bounded

    complete = prefix(len(content))
    if _encoded_size(complete) <= max_chars:
        return complete
    low, high = 0, len(content)
    while low < high:
        middle = (low + high + 1) // 2
        if _encoded_size(prefix(middle)) <= max_chars:
            low = middle
        else:
            high = middle - 1
    return prefix(low)


def tool_result_model_context(result: ToolResult, max_chars: int = _MAX_MODEL_CONTEXT_CHARS) -> dict[str, Any]:
    # Full replacement requires the complete bounded document, not a 4k preview.
    if result.tool in {"user_profile_read", "user_profile_update", "workspace_memory_read", "workspace_memory_update"} and result.success and isinstance(result.data, dict):
        content, revision = result.data.get("content"), result.data.get("revision")
        if isinstance(content, str) and len(content) <= 16000 and isinstance(revision, str) and len(revision) == 64:
            return {"facts": [], "structuredData": {"content": content, "revision": revision}}
    raw = result.data if isinstance(result.data, dict) else {"value": result.data}
    facts_value = raw.get("facts") if isinstance(raw, dict) else None
    facts = [
        item.strip()[:_MAX_FACT_CHARS]
        for item in (facts_value if isinstance(facts_value, list) else [])[:_MAX_FACTS]
        if isinstance(item, str) and item.strip()
    ]
    clipping = [False]
    structured = _safe_model_value({
        key: value for key, value in raw.items()
        if key != "facts"
    }, clipped=clipping)
    if clipping[0]:
        structured["truncated"] = True
    context = {"facts": facts, "structuredData": structured if isinstance(structured, dict) else {}}
    if result.tool == "file_read" and isinstance(raw.get("content"), str):
        overhead = _encoded_size({"facts": facts, "structuredData": {}}) - 2
        context["structuredData"] = bounded_file_read_data(raw, max_chars - overhead)
        return context
    if result.tool == "rag_search" and isinstance(raw.get("sources"), list):
        overhead = _encoded_size({"facts": facts, "structuredData": {}}) - 2
        context["structuredData"] = bounded_rag_data(raw, max_chars - overhead)
        return context
    encoded = json.dumps(context, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(encoded) > max_chars:
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
    model_context = tool_result_model_context(result)
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
            "modelContext": model_context,
            "durationMs": max(0, int(duration_ms)),
            "error": result.error.model_dump() if result.error is not None else None,
            "truncated": result.truncated or model_context.get("structuredData", {}).get("truncated") is True,
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
    return event("error", run_id, error=error.model_dump())
