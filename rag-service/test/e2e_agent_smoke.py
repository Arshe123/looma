"""Real-service smoke checks for Looma's read-only Agent loop.

Start the RAG service first, then run:
    python test/e2e_agent_smoke.py

Set LOOMA_RAG_URL when the service is not listening on 127.0.0.1:8767.
This script intentionally uses the configured real chat model instead of a fake provider.
"""

from __future__ import annotations

import json
import os
import tempfile
import urllib.request
from pathlib import Path
from typing import Any


BASE_URL = os.environ.get("LOOMA_RAG_URL", "http://127.0.0.1:8767").rstrip("/")


def run_agent(workspace: Path, prompt: str, tools: list[str], max_steps: int = 4) -> list[dict[str, Any]]:
    payload = {
        "input": prompt,
        "workspace": {"workspace_path": str(workspace)},
        "agent": {
            "enabled_tools": tools,
            "max_steps": max_steps,
            "tool_timeout_seconds": 15,
            "run_timeout_seconds": 45,
            "allow_write": False,
        },
        "history": [],
    }
    request = urllib.request.Request(
        f"{BASE_URL}/agent/run/stream",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    events: list[dict[str, Any]] = []
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.status != 200:
            raise AssertionError(f"Agent endpoint returned HTTP {response.status}")
        for raw_line in response:
            line = raw_line.decode("utf-8").strip()
            if line:
                events.append(json.loads(line))
    return events


def assert_completed(events: list[dict[str, Any]]) -> None:
    event_types = [event.get("type") for event in events]
    if not event_types or event_types[0] != "run_started":
        raise AssertionError(f"Expected run_started first, got {event_types[:1]}")
    if not any(event.get("type") == "done" and event.get("status") == "completed" for event in events):
        raise AssertionError(f"Expected completed done event, got {events}")


def called_tools(events: list[dict[str, Any]]) -> list[str]:
    return [str(event.get("tool")) for event in events if event.get("type") == "tool_call"]


def run_tool_scenario(
    workspace: Path,
    prompt: str,
    tools: list[str],
    expected_tools: set[str],
    max_steps: int = 4,
) -> list[dict[str, Any]]:
    last_events: list[dict[str, Any]] = []
    for _ in range(3):
        last_events = run_agent(workspace, prompt, tools, max_steps=max_steps)
        try:
            assert_completed(last_events)
        except AssertionError:
            continue
        if expected_tools.issubset(called_tools(last_events)):
            return last_events
    raise AssertionError(
        f"Expected completed run using {sorted(expected_tools)}, got {last_events}"
    )


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="looma-agent-e2e-") as temp_dir:
        workspace = Path(temp_dir)
        (workspace / "docs").mkdir()
        (workspace / "config").mkdir()
        (workspace / "README.md").write_text(
            "# Smoke workspace\n\nVerification phrase: amber-orchid-47.\nSee docs/guide.md.\n",
            encoding="utf-8",
        )
        (workspace / "docs" / "guide.md").write_text("# Guide\n\nAgent tools are read-only.\n", encoding="utf-8")
        (workspace / "config" / "app.yaml").write_text("agent_mode: safe\n", encoding="utf-8")

        run_tool_scenario(
            workspace,
            "这个工作区没有索引。先调用 workspace_list 确认 README.md，再调用 file_read 读取它，并报告文件内容中的 Verification phrase；仅凭文件名无法回答。",
            ["workspace_list", "file_read"],
            {"workspace_list", "file_read"},
        )
        print("PASS no-index workspace_list + file_read")

        run_tool_scenario(
            workspace,
            "调用 workspace_search 时 arguments 只能使用 query='agent_mode'、glob='*'、max_results=10，不能传 path；找到 config/app.yaml 后，再调用 file_read 读取该相对路径并报告字段值。",
            ["workspace_search", "file_read"],
            {"workspace_search", "file_read"},
        )
        print("PASS workspace_search + file_read")

        escape_events = run_agent(
            workspace,
            "调用 file_read 尝试读取 ../outside-secret.txt；如果工具拒绝，请解释路径不能越过工作区。",
            ["file_read"],
            max_steps=2,
        )
        assert_completed(escape_events)
        denied_results = [
            event for event in escape_events
            if event.get("type") == "tool_result"
            and event.get("result", {}).get("success") is False
        ]
        if not denied_results:
            raise AssertionError("Expected an unsuccessful tool_result for workspace escape")
        print("PASS workspace escape rejected and run recovered")


if __name__ == "__main__":
    main()
