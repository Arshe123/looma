from __future__ import annotations

import fnmatch
import os
import re
import unicodedata
from typing import Any

from pydantic import Field, validator

from agent.security import resolve_workspace_path
from agent.tools.base import AgentTool, AgentToolContext, StrictToolArgs
from agent.tools.workspace_common import (
    MAX_SCAN_ENTRIES,
    MAX_SEARCH_FILE_BYTES,
    ScanBudget,
    iter_workspace_files,
    open_regular_no_follow,
    relative_posix,
)


_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")
SNIPPET_LIMIT = 240


class WorkspaceSearchArgs(StrictToolArgs):
    query: str = Field(..., min_length=1, max_length=500)
    glob: str = Field(default="*", min_length=1, max_length=200)
    max_results: int = Field(default=50, ge=1, le=200)

    @validator("query")
    def strip_non_empty_query(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("query must not be blank")
        return stripped

    @validator("glob")
    def validate_safe_glob(cls, value: str) -> str:
        normalized = value.replace("\\", "/")
        if "\x00" in normalized or normalized.startswith("/") or _WINDOWS_DRIVE.match(normalized):
            raise ValueError("glob must be a relative workspace pattern")
        if ".." in normalized.split("/"):
            raise ValueError("glob must not contain parent traversal")
        return normalized


class WorkspaceSearchTool(AgentTool):
    name = "workspace_search"
    description = "Search workspace filenames and UTF-8 text using a plain substring."
    risk_level = "read"
    args_model = WorkspaceSearchArgs

    async def execute(self, context: AgentToolContext, args: StrictToolArgs) -> dict[str, Any]:
        if not isinstance(args, WorkspaceSearchArgs):
            raise TypeError("args must be WorkspaceSearchArgs")

        workspace = resolve_workspace_path(context.workspace_path, ".", must_exist=True)
        needle = args.query.casefold()
        matches: list[dict[str, Any]] = []
        truncated = False
        budget = ScanBudget(MAX_SCAN_ENTRIES)

        def add_match(match: dict[str, Any]) -> bool:
            nonlocal truncated
            if len(matches) >= args.max_results:
                truncated = True
                return False
            matches.append(match)
            return True

        for path in iter_workspace_files(workspace, budget):
            relative = relative_posix(workspace, path)
            if not fnmatch.fnmatchcase(relative, args.glob):
                continue

            descriptor = open_regular_no_follow(path)
            if descriptor is None:
                continue
            try:
                if os.fstat(descriptor).st_size > MAX_SEARCH_FILE_BYTES:
                    continue
                with os.fdopen(descriptor, "rb", closefd=True) as handle:
                    descriptor = -1
                    raw_content = handle.read(MAX_SEARCH_FILE_BYTES + 1)
                if len(raw_content) > MAX_SEARCH_FILE_BYTES or b"\x00" in raw_content:
                    continue
                text = raw_content.decode("utf-8", errors="strict")
            except (OSError, UnicodeDecodeError):
                continue
            finally:
                if descriptor >= 0:
                    try:
                        os.close(descriptor)
                    except OSError:
                        pass

            if needle in path.name.casefold():
                if not add_match(
                    {
                        "path": relative,
                        "line": 0,
                        "snippet": _clean_snippet(relative),
                        "matchType": "filename",
                    }
                ):
                    break

            for line_number, line in enumerate(text.splitlines(), start=1):
                if needle not in line.casefold():
                    continue
                if not add_match(
                    {
                        "path": relative,
                        "line": line_number,
                        "snippet": _clean_snippet(line),
                        "matchType": "content",
                    }
                ):
                    break
            if truncated:
                break

        return {
            "status": "ok" if matches else "no_results",
            "query": args.query,
            "matches": matches,
            "count": len(matches),
            "truncated": truncated or budget.exhausted,
        }


def _clean_snippet(value: str) -> str:
    cleaned = "".join(
        " " if unicodedata.category(character).startswith("C") else character
        for character in value
    )
    return " ".join(cleaned.split())[:SNIPPET_LIMIT]
