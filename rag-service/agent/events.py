from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel

from agent.models import AgentError, ToolResult


def model_dump(value: BaseModel) -> dict[str, Any]:
    dump = getattr(value, "model_dump", None)
    return dump() if dump is not None else value.dict()


def utc_iso_z() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def event(event_type: str, run_id: str, **payload: Any) -> dict[str, Any]:
    if not event_type or not run_id:
        raise ValueError("event type and run_id are required")
    return {"type": event_type, "runId": run_id, **payload}


def tool_result_event(run_id: str, *, step: int, step_id: str, call_id: str, result: ToolResult) -> dict[str, Any]:
    return event(
        "tool_result", run_id, step=step, stepId=step_id,
        callId=call_id, result=model_dump(result),
    )


def error_event(run_id: str, error: AgentError) -> dict[str, Any]:
    return event("error", run_id, error=model_dump(error))
