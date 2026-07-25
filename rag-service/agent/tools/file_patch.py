from __future__ import annotations

import asyncio
import codecs
import difflib
import hashlib
import os
import stat
from pathlib import Path

from pydantic import Field, root_validator

from agent.security import WorkspaceSecurityError
from agent.tools.base import AgentTool, AgentToolContext, StrictToolArgs
from agent.tools.staging import AgentStagingArea, StagedFile
from agent.tools.workspace_common import (
    open_regular_no_follow,
    resolve_no_follow_workspace_path,
)


MAX_PATCH_SOURCE_BYTES = 200_000
MAX_PATCH_CONTENT_CHARS = 200_000
READ_CHUNK_BYTES = 64 * 1024


class FilePatchArgs(StrictToolArgs):
    path: str = Field(..., min_length=1)
    old_text: str | None = None
    new_text: str | None = None
    new_content: str | None = None

    @root_validator(skip_on_failure=True)
    def validate_operation(cls, values: dict[str, object]) -> dict[str, object]:
        old_text = values.get("old_text")
        new_text = values.get("new_text")
        new_content = values.get("new_content")
        if new_content is not None:
            if old_text is not None or new_text is not None:
                raise ValueError("new_content cannot be combined with old_text/new_text")
            if not isinstance(new_content, str) or not new_content:
                raise ValueError("new_content must be a non-empty string")
            return values
        if not isinstance(old_text, str) or not isinstance(new_text, str):
            raise ValueError("old_text and new_text are required for updates")
        if old_text == "":
            raise ValueError("old_text must not be empty")
        return values


class FilePatchTool(AgentTool):
    name = "file_patch"
    description = (
        "Modify a run-isolated staged copy of one UTF-8 workspace file. Consecutive calls "
        "use the previous staged content; Electron approval is required before the "
        "cumulative change is written to the workspace."
    )
    risk_level = "write"
    args_model = FilePatchArgs

    async def execute(self, context: AgentToolContext, args: StrictToolArgs) -> dict[str, object]:
        return await asyncio.to_thread(self._execute_sync, context, args)

    def _execute_sync(self, context: AgentToolContext, args: StrictToolArgs) -> dict[str, object]:
        if not isinstance(args, FilePatchArgs):
            raise TypeError("args must be FilePatchArgs")
        try:
            target = resolve_no_follow_workspace_path(context.workspace_path, args.path)
            staging = AgentStagingArea(context.workspace_path, context.run_id)
            staged = staging.load(args.path)
        except WorkspaceSecurityError as exc:
            raise ValueError(exc.code) from None

        if staged is None:
            original_content = self._read_utf8_text(target) if os.path.lexists(target) else None
            if args.new_content is not None:
                if original_content is not None:
                    raise ValueError("target already exists")
                proposed_content = args.new_content
            else:
                if original_content is None:
                    raise ValueError("target does not exist")
                assert args.old_text is not None
                assert args.new_text is not None
                matches = original_content.count(args.old_text)
                if matches != 1:
                    raise ValueError("old_text must match exactly once in the current staged file")
                proposed_content = original_content.replace(args.old_text, args.new_text, 1)
            self._validate_proposed_content(proposed_content)
            try:
                staged = staging.initialize(args.path, original_content)
            except WorkspaceSecurityError as exc:
                raise ValueError(exc.code) from None
        elif args.new_content is not None:
            proposed_content = args.new_content
            self._validate_proposed_content(proposed_content)
        else:
            assert args.old_text is not None
            assert args.new_text is not None
            matches = staged.current_content.count(args.old_text)
            if matches != 1:
                raise ValueError("old_text must match exactly once in the current staged file")
            proposed_content = staged.current_content.replace(args.old_text, args.new_text, 1)
            self._validate_proposed_content(proposed_content)

        try:
            staged = staging.write(staged, proposed_content)
        except WorkspaceSecurityError as exc:
            raise ValueError(exc.code) from None
        return self._proposal(staged=staged, proposed_content=proposed_content)

    def _proposal(
        self,
        *,
        staged: StagedFile,
        proposed_content: str,
    ) -> dict[str, object]:
        from_name = "/dev/null" if staged.operation == "create" else staged.path
        unified_diff = "".join(
            difflib.unified_diff(
                staged.base_content.splitlines(keepends=True),
                proposed_content.splitlines(keepends=True),
                fromfile=from_name,
                tofile=staged.path,
                lineterm="",
            )
        )
        return {
            "requiresApproval": True,
            "path": staged.path,
            "operation": staged.operation,
            "unified_diff": unified_diff,
            "expected_sha256": staged.expected_sha256,
            "proposed_sha256": self._sha256(proposed_content),
            "proposed_content": proposed_content,
            "staging": {
                "run_id": staged.run_id,
                "source": "staged_copy",
                "workspace_disk_changed": False,
            },
        }

    def _read_utf8_text(self, target: Path) -> str:
        try:
            target_stat = target.stat(follow_symlinks=False)
        except OSError:
            raise ValueError("target is inaccessible") from None
        if not stat.S_ISREG(target_stat.st_mode):
            raise ValueError("target is not a regular file")
        if target_stat.st_size > MAX_PATCH_SOURCE_BYTES:
            raise ValueError("target file is too large")

        descriptor = open_regular_no_follow(target)
        if descriptor is None:
            raise ValueError("target is not a safe regular file")

        decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
        parts: list[str] = []
        total_bytes = 0
        try:
            with os.fdopen(descriptor, "rb", closefd=True) as handle:
                descriptor = -1
                while True:
                    chunk = handle.read(READ_CHUNK_BYTES)
                    if not chunk:
                        break
                    total_bytes += len(chunk)
                    if total_bytes > MAX_PATCH_SOURCE_BYTES:
                        raise ValueError("target file is too large")
                    if b"\x00" in chunk:
                        raise ValueError("target file is binary")
                    parts.append(decoder.decode(chunk, final=False))
                parts.append(decoder.decode(b"", final=True))
        except UnicodeDecodeError:
            raise ValueError("target file is not valid UTF-8 text") from None
        finally:
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass

        return "".join(parts)

    def _validate_proposed_content(self, value: str) -> None:
        if not value:
            raise ValueError("proposed content must not be empty")
        if len(value) > MAX_PATCH_CONTENT_CHARS:
            raise ValueError("proposed content is too large")
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raise ValueError("proposed content must be valid UTF-8") from None

    @staticmethod
    def _sha256(value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()
