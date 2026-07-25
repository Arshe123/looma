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
from agent.tools.base import AgentTool, AgentToolContext, StrictToolArgs, ToolExecutionError
from agent.tools.staging import AgentStagingArea, StagedFile
from agent.tools.workspace_common import (
    open_regular_no_follow,
    resolve_no_follow_workspace_path,
)


MAX_PATCH_SOURCE_BYTES = 200_000
MAX_PATCH_CONTENT_CHARS = 200_000
MAX_PATCH_CONTENT_BYTES = 200_000
READ_CHUNK_BYTES = 64 * 1024


class FilePatchArgs(StrictToolArgs):
    path: str = Field(
        ...,
        min_length=1,
        max_length=1024,
        description="Workspace-relative UTF-8 text file path.",
    )
    old_text: str | None = Field(
        None,
        max_length=MAX_PATCH_CONTENT_CHARS,
        description=(
            "Exact text to replace in an existing file. It must occur exactly once "
            "in the current staged version."
        ),
    )
    new_text: str | None = Field(
        None,
        max_length=MAX_PATCH_CONTENT_CHARS,
        description="Replacement text used together with old_text.",
    )
    new_content: str | None = Field(
        None,
        max_length=MAX_PATCH_CONTENT_CHARS,
        description=(
            "Complete content for creating a file that does not exist. "
            "Do not combine with old_text/new_text."
        ),
    )

    @root_validator(skip_on_failure=True)
    def validate_operation(cls, values: dict[str, object]) -> dict[str, object]:
        old_text = values.get("old_text")
        new_text = values.get("new_text")
        new_content = values.get("new_content")
        if new_content is not None:
            if old_text is not None or new_text is not None:
                raise ValueError("file_patch_new_content_conflict")
            if not isinstance(new_content, str) or not new_content:
                raise ValueError("file_patch_new_content_empty")
            return values
        if not isinstance(old_text, str) or not isinstance(new_text, str):
            raise ValueError("file_patch_update_fields_required")
        if old_text == "":
            raise ValueError("file_patch_old_text_empty")
        return values


class FilePatchTool(AgentTool):
    name = "file_patch"
    description = (
        "Modify one run-isolated staged UTF-8 workspace file. Source and resulting content "
        "must each be at most 200,000 UTF-8 bytes (and 200,000 characters). For an existing "
        "file, use old_text/new_text and old_text must match exactly once in the current staged "
        "version; new_content is only for creating a file that does not exist. Consecutive calls "
        "use the previous staged content. Only the final cumulative version is offered for "
        "Electron review after the Agent run finishes; workspace disk is unchanged before approval."
    )
    risk_level = "write"
    args_model = FilePatchArgs

    async def execute(self, context: AgentToolContext, args: StrictToolArgs) -> dict[str, object]:
        return await asyncio.to_thread(self._execute_sync, context, args)

    @staticmethod
    def _expected_error(code: str, message: str, *, retryable: bool = True) -> ToolExecutionError:
        return ToolExecutionError(code, message, retryable=retryable)

    def _execute_sync(self, context: AgentToolContext, args: StrictToolArgs) -> dict[str, object]:
        if not isinstance(args, FilePatchArgs):
            raise TypeError("args must be FilePatchArgs")
        try:
            target = resolve_no_follow_workspace_path(context.workspace_path, args.path)
            staging = AgentStagingArea(context.workspace_path, context.run_id)
            staged = staging.load(args.path)
        except WorkspaceSecurityError as exc:
            raise self._expected_error(
                f"file_patch_{exc.code}",
                "file_patch rejected the path because it is outside the safe workspace file boundary.",
                retryable=False,
            ) from None

        if staged is None:
            original_content = self._read_utf8_text(target) if os.path.lexists(target) else None
            if args.new_content is not None:
                if original_content is not None:
                    raise self._expected_error(
                        "file_patch_target_exists",
                        "The target already exists. Read it, then use old_text/new_text instead of new_content.",
                    )
                proposed_content = args.new_content
            else:
                if original_content is None:
                    raise self._expected_error(
                        "file_patch_target_missing",
                        "The target does not exist. Use new_content to create it.",
                    )
                assert args.old_text is not None
                assert args.new_text is not None
                proposed_content = self._replace_exactly_once(
                    original_content,
                    args.old_text,
                    args.new_text,
                )
            self._validate_proposed_content(proposed_content)
            try:
                staged = staging.initialize(args.path, original_content)
            except WorkspaceSecurityError as exc:
                raise self._expected_error(
                    f"file_patch_{exc.code}",
                    "file_patch could not initialize a safe staged file for this path.",
                    retryable=False,
                ) from None
        elif args.new_content is not None:
            proposed_content = args.new_content
            self._validate_proposed_content(proposed_content)
        else:
            assert args.old_text is not None
            assert args.new_text is not None
            proposed_content = self._replace_exactly_once(
                staged.current_content,
                args.old_text,
                args.new_text,
            )
            self._validate_proposed_content(proposed_content)

        try:
            staged = staging.write(staged, proposed_content)
        except WorkspaceSecurityError as exc:
            raise self._expected_error(
                f"file_patch_{exc.code}",
                "file_patch could not safely update the staged file.",
                retryable=False,
            ) from None
        return self._proposal(staged=staged, proposed_content=proposed_content)

    def _replace_exactly_once(self, content: str, old_text: str, new_text: str) -> str:
        matches = content.count(old_text)
        if matches != 1:
            raise self._expected_error(
                "file_patch_old_text_not_unique",
                (
                    "old_text must match exactly once in the current staged file; "
                    f"matched {matches} times. Read the staged file and retry with a unique exact snippet."
                ),
            )
        return content.replace(old_text, new_text, 1)

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
            raise self._expected_error(
                "file_patch_target_inaccessible",
                "The target file is inaccessible.",
            ) from None
        if not stat.S_ISREG(target_stat.st_mode):
            raise self._expected_error(
                "file_patch_target_not_regular",
                "The target is not a regular file.",
                retryable=False,
            )
        if target_stat.st_size > MAX_PATCH_SOURCE_BYTES:
            raise self._expected_error(
                "file_patch_source_too_large",
                "The target exceeds the 200,000-byte file_patch source limit.",
                retryable=False,
            )

        descriptor = open_regular_no_follow(target)
        if descriptor is None:
            raise self._expected_error(
                "file_patch_target_not_safe",
                "The target is not a safe regular workspace file.",
                retryable=False,
            )

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
                        raise self._expected_error(
                            "file_patch_source_too_large",
                            "The target exceeds the 200,000-byte file_patch source limit.",
                            retryable=False,
                        )
                    if b"\x00" in chunk:
                        raise self._expected_error(
                            "file_patch_binary_file",
                            "file_patch only supports UTF-8 text files, not binary files.",
                            retryable=False,
                        )
                    parts.append(decoder.decode(chunk, final=False))
                parts.append(decoder.decode(b"", final=True))
        except UnicodeDecodeError:
            raise self._expected_error(
                "file_patch_invalid_utf8",
                "file_patch only supports valid UTF-8 text files.",
                retryable=False,
            ) from None
        finally:
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass

        return "".join(parts)

    def _validate_proposed_content(self, value: str) -> None:
        if not value:
            raise self._expected_error(
                "file_patch_empty_content",
                "The resulting file content must not be empty.",
            )
        if len(value) > MAX_PATCH_CONTENT_CHARS:
            raise self._expected_error(
                "file_patch_content_too_large",
                "The resulting content exceeds the 200,000-character file_patch limit.",
            )
        try:
            encoded = value.encode("utf-8")
        except UnicodeEncodeError:
            raise self._expected_error(
                "file_patch_invalid_utf8",
                "The resulting content must be valid UTF-8 text.",
            ) from None
        if len(encoded) > MAX_PATCH_CONTENT_BYTES:
            raise self._expected_error(
                "file_patch_content_too_large",
                "The resulting content exceeds the 200,000-byte UTF-8 file_patch limit.",
            )

    @staticmethod
    def _sha256(value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()
