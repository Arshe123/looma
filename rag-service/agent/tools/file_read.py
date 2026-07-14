from __future__ import annotations

import asyncio
import codecs
import os
import stat
from typing import Any

from pydantic import Field, root_validator

from agent.security import resolve_workspace_path
from agent.tools.base import AgentTool, AgentToolContext, StrictToolArgs
from agent.tools.workspace_common import (
    observation_path,
    open_regular_no_follow,
    relative_posix,
    resolve_no_follow_workspace_path,
)


READ_CHUNK_BYTES = 64 * 1024


class FileReadArgs(StrictToolArgs):
    path: str = Field(..., min_length=1)
    start_line: int = Field(default=1, ge=1, le=100000)
    end_line: int | None = Field(default=None, ge=1, le=100000)
    max_chars: int = Field(default=20000, ge=1, le=50000)

    @root_validator(skip_on_failure=True)
    def validate_line_range(cls, values: dict[str, Any]) -> dict[str, Any]:
        start_line = values.get("start_line")
        end_line = values.get("end_line")
        if end_line is not None and start_line is not None and end_line < start_line:
            raise ValueError("end_line must be greater than or equal to start_line")
        return values


class FileReadTool(AgentTool):
    name = "file_read"
    description = "Read a bounded range from a UTF-8 text file inside the workspace."
    risk_level = "read"
    args_model = FileReadArgs

    async def execute(self, context: AgentToolContext, args: StrictToolArgs) -> dict[str, Any]:
        return await asyncio.to_thread(self._execute_sync, context, args)

    def _execute_sync(self, context: AgentToolContext, args: StrictToolArgs) -> dict[str, Any]:
        if not isinstance(args, FileReadArgs):
            raise TypeError("args must be FileReadArgs")

        workspace = resolve_workspace_path(context.workspace_path, ".", must_exist=True)
        target = resolve_no_follow_workspace_path(context.workspace_path, args.path)
        result_path = observation_path(args.path)
        try:
            target_stat = target.stat(follow_symlinks=False)
        except FileNotFoundError:
            return self._observation("not_found", result_path, args.start_line)
        except OSError:
            return self._observation("inaccessible", result_path, args.start_line)
        if not stat.S_ISREG(target_stat.st_mode):
            return self._observation("not_file", relative_posix(workspace, target), args.start_line)
        result_path = relative_posix(workspace, target)

        descriptor = open_regular_no_follow(target)
        if descriptor is None:
            return self._observation("inaccessible", result_path, args.start_line)

        content_parts: list[str] = []
        content_length = 0
        current_line = 1
        last_returned_line = 0
        truncated = False
        saw_character = False
        last_was_lf = False
        pending_cr = False
        decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")

        def emit(character: str) -> None:
            nonlocal content_length, current_line, last_returned_line
            nonlocal truncated, saw_character, last_was_lf
            saw_character = True
            last_was_lf = character == "\n"
            selected = current_line >= args.start_line and (
                args.end_line is None or current_line <= args.end_line
            )
            if selected:
                if content_length < args.max_chars:
                    content_parts.append(character)
                    content_length += 1
                    last_returned_line = current_line
                else:
                    truncated = True
            if character == "\n":
                current_line += 1

        def consume(text: str, *, final: bool = False) -> None:
            nonlocal pending_cr
            for character in text:
                if pending_cr:
                    emit("\n")
                    pending_cr = False
                    if character == "\n":
                        continue
                if character == "\r":
                    pending_cr = True
                else:
                    emit(character)
            if final and pending_cr:
                emit("\n")
                pending_cr = False

        try:
            with os.fdopen(descriptor, "rb", closefd=True) as handle:
                descriptor = -1
                while True:
                    chunk = handle.read(READ_CHUNK_BYTES)
                    if not chunk:
                        break
                    if b"\x00" in chunk:
                        return self._observation("binary_file", result_path, args.start_line)
                    consume(decoder.decode(chunk, final=False))
                consume(decoder.decode(b"", final=True), final=True)
        except UnicodeDecodeError:
            return self._observation("binary_file", result_path, args.start_line)
        except OSError:
            return self._observation("inaccessible", result_path, args.start_line)
        finally:
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass

        total_lines = current_line - 1 if saw_character and last_was_lf else current_line
        if not saw_character:
            total_lines = 0
        return {
            "status": "ok",
            "path": result_path,
            "content": "".join(content_parts),
            "startLine": args.start_line,
            "endLine": last_returned_line,
            "totalLines": total_lines,
            "truncated": truncated,
        }

    @staticmethod
    def _observation(status: str, path: str, start_line: int) -> dict[str, Any]:
        return {
            "status": status,
            "path": path,
            "content": "",
            "startLine": start_line,
            "endLine": 0,
            "totalLines": 0,
            "truncated": False,
        }
