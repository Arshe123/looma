from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from pydantic import Field

from agent.security import resolve_workspace_path
from agent.tools.base import AgentTool, AgentToolContext, StrictToolArgs
from agent.tools.workspace_common import (
    IGNORED_DIRECTORIES,
    MAX_SCAN_ENTRIES,
    ScanBudget,
    is_link_or_reparse,
    observation_path,
    relative_posix,
    resolve_no_follow_workspace_path,
    sorted_directory_entries,
)


class WorkspaceListArgs(StrictToolArgs):
    path: str = "."
    depth: int = Field(default=1, ge=0, le=5)
    limit: int = Field(default=200, ge=1, le=1000)


class WorkspaceListTool(AgentTool):
    name = "workspace_list"
    description = "List files and directories inside the current workspace."
    risk_level = "read"
    args_model = WorkspaceListArgs

    async def execute(self, context: AgentToolContext, args: StrictToolArgs) -> dict[str, Any]:
        return await asyncio.to_thread(self._execute_sync, context, args)

    def _execute_sync(self, context: AgentToolContext, args: StrictToolArgs) -> dict[str, Any]:
        if not isinstance(args, WorkspaceListArgs):
            raise TypeError("args must be WorkspaceListArgs")

        workspace = resolve_workspace_path(context.workspace_path, ".", must_exist=True)
        target = resolve_no_follow_workspace_path(context.workspace_path, args.path)
        result_path = observation_path(args.path)
        if not target.exists():
            return self._empty("not_found", result_path)
        if not target.is_dir():
            return self._empty("not_directory", relative_posix(workspace, target))

        result_path = relative_posix(workspace, target)
        if args.depth == 0:
            return self._empty("ok", result_path)

        entries: list[dict[str, Any]] = []
        truncated = False
        inaccessible = False
        budget = ScanBudget(MAX_SCAN_ENTRIES)

        def visit(directory: Path, remaining_depth: int) -> bool:
            nonlocal truncated, inaccessible
            children = sorted_directory_entries(directory, budget)
            if children is None:
                inaccessible = True
                return False
            for child in children:
                path = Path(child.path)
                if is_link_or_reparse(path):
                    continue
                try:
                    is_directory = child.is_dir(follow_symlinks=False)
                    is_file = child.is_file(follow_symlinks=False)
                except OSError:
                    continue
                if is_directory and child.name.casefold() in IGNORED_DIRECTORIES:
                    continue
                if not is_directory and not is_file:
                    continue
                if len(entries) >= args.limit:
                    truncated = True
                    return True
                entry: dict[str, Any] = {
                    "path": relative_posix(workspace, path),
                    "type": "directory" if is_directory else "file",
                }
                if is_file:
                    try:
                        entry["size"] = child.stat(follow_symlinks=False).st_size
                    except OSError:
                        pass
                entries.append(entry)
                if (
                    is_directory
                    and remaining_depth > 1
                    and not budget.exhausted
                    and visit(path, remaining_depth - 1)
                ):
                    return True
            return False

        visit(target, args.depth)
        status = "inaccessible" if inaccessible and not entries else "ok"
        return {
            "status": status,
            "path": result_path,
            "entries": entries,
            "count": len(entries),
            "truncated": truncated or budget.exhausted,
        }

    @staticmethod
    def _empty(status: str, path: str) -> dict[str, Any]:
        return {"status": status, "path": path, "entries": [], "count": 0, "truncated": False}
