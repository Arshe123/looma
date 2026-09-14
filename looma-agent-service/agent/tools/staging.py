from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import uuid
from dataclasses import dataclass
from pathlib import Path

from agent.security import WorkspaceSecurityError
from agent.tools.workspace_common import (
    is_link_or_reparse,
    relative_posix,
    resolve_no_follow_workspace_path,
)


_SAFE_RUN_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")


@dataclass(frozen=True)
class StagedFile:
    run_id: str
    path: str
    operation: str
    expected_sha256: str | None
    base_content: str
    current_content: str
    staged_path: Path


class AgentStagingArea:
    """Run-isolated staged file view stored below .looma/agent-staging."""

    def __init__(self, workspace_path: str | Path, run_id: str | None) -> None:
        safe_run_id = run_id or "standalone"
        if not _SAFE_RUN_ID.fullmatch(safe_run_id):
            raise WorkspaceSecurityError(
                "invalid_agent_run_id",
                "The Agent run identifier is invalid.",
            )
        self.workspace = resolve_no_follow_workspace_path(
            workspace_path,
            ".",
            must_exist=True,
        )
        self.run_id = safe_run_id
        self.root = self.workspace / ".looma" / "agent-staging" / safe_run_id
        self.files_root = self.root / "files"
        self.base_root = self.root / "base"
        self.meta_root = self.root / "meta"

    def _relative_path(self, value: str) -> str:
        target = resolve_no_follow_workspace_path(self.workspace, value)
        relative = relative_posix(self.workspace, target)
        if relative == "." or any(
            segment.casefold() == ".looma" for segment in relative.split("/")
        ):
            raise WorkspaceSecurityError(
                "workspace_internal_path",
                "The .looma directory is reserved for application internals.",
            )
        return relative

    def _ensure_safe_directory(self, directory: Path) -> None:
        try:
            relative = directory.relative_to(self.workspace)
        except ValueError as exc:
            raise WorkspaceSecurityError(
                "staging_path_escape",
                "The staging path escapes the workspace.",
            ) from exc
        cursor = self.workspace
        for part in relative.parts:
            cursor = cursor / part
            if os.path.lexists(cursor) and is_link_or_reparse(cursor):
                raise WorkspaceSecurityError(
                    "staging_link_not_allowed",
                    "Links and reparse points are not allowed in the staging area.",
                )
        directory.mkdir(parents=True, exist_ok=True)
        cursor = self.workspace
        for part in relative.parts:
            cursor = cursor / part
            if is_link_or_reparse(cursor):
                raise WorkspaceSecurityError(
                    "staging_link_not_allowed",
                    "Links and reparse points are not allowed in the staging area.",
                )

    def _assert_safe_existing_components(self, target: Path) -> None:
        try:
            relative = target.relative_to(self.workspace)
        except ValueError as exc:
            raise WorkspaceSecurityError(
                "staging_path_escape",
                "The staging path escapes the workspace.",
            ) from exc
        cursor = self.workspace
        for part in relative.parts:
            cursor = cursor / part
            if not os.path.lexists(cursor):
                break
            if is_link_or_reparse(cursor):
                raise WorkspaceSecurityError(
                    "staging_link_not_allowed",
                    "Links and reparse points are not allowed in the staging area.",
                )

    def _paths(self, relative: str) -> tuple[Path, Path, Path]:
        parts = relative.split("/")
        staged_path = self.files_root.joinpath(*parts)
        base_path = self.base_root.joinpath(*parts)
        meta_name = hashlib.sha256(relative.encode("utf-8")).hexdigest() + ".json"
        meta_path = self.meta_root / meta_name
        return staged_path, base_path, meta_path

    @staticmethod
    def _read_regular_text(path: Path) -> str:
        if is_link_or_reparse(path) or not path.is_file():
            raise WorkspaceSecurityError(
                "invalid_staging_file",
                "The staged file is not a regular file.",
            )
        return path.read_text(encoding="utf-8")

    def load(self, value: str) -> StagedFile | None:
        relative = self._relative_path(value)
        staged_path, base_path, meta_path = self._paths(relative)
        self._assert_safe_existing_components(meta_path)
        if not os.path.lexists(meta_path):
            return None
        self._assert_safe_existing_components(staged_path)
        self._assert_safe_existing_components(base_path)
        if not os.path.lexists(staged_path) or not os.path.lexists(base_path):
            raise WorkspaceSecurityError(
                "incomplete_staging_entry",
                "The staged file cache is incomplete.",
            )
        metadata = json.loads(self._read_regular_text(meta_path))
        if metadata.get("path") != relative or metadata.get("operation") not in {
            "create",
            "update",
        }:
            raise WorkspaceSecurityError(
                "invalid_staging_metadata",
                "The staged file metadata is invalid.",
            )
        base_content = self._read_regular_text(base_path)
        expected_sha256 = metadata.get("expected_sha256")
        if expected_sha256 is not None and not isinstance(expected_sha256, str):
            raise WorkspaceSecurityError(
                "invalid_staging_metadata",
                "The staged file metadata is invalid.",
            )
        if metadata["operation"] == "create":
            if expected_sha256 is not None or base_content:
                raise WorkspaceSecurityError(
                    "invalid_staging_metadata",
                    "The staged create metadata is invalid.",
                )
        elif hashlib.sha256(base_content.encode("utf-8")).hexdigest() != expected_sha256:
            raise WorkspaceSecurityError(
                "staging_base_hash_mismatch",
                "The staged file base content has changed unexpectedly.",
            )
        return StagedFile(
            run_id=self.run_id,
            path=relative,
            operation=metadata["operation"],
            expected_sha256=expected_sha256,
            base_content=base_content,
            current_content=self._read_regular_text(staged_path),
            staged_path=staged_path,
        )

    @staticmethod
    def _atomic_write(path: Path, content: str) -> None:
        if os.path.lexists(path) and is_link_or_reparse(path):
            raise WorkspaceSecurityError(
                "staging_link_not_allowed",
                "Links and reparse points are not allowed in the staging area.",
            )
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0),
            0o600,
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
                descriptor = -1
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    def initialize(self, value: str, original_content: str | None) -> StagedFile:
        existing = self.load(value)
        if existing is not None:
            return existing
        relative = self._relative_path(value)
        staged_path, base_path, meta_path = self._paths(relative)
        self._ensure_safe_directory(staged_path.parent)
        self._ensure_safe_directory(base_path.parent)
        self._ensure_safe_directory(meta_path.parent)
        operation = "create" if original_content is None else "update"
        base_content = original_content or ""
        expected_sha256 = (
            None
            if original_content is None
            else hashlib.sha256(original_content.encode("utf-8")).hexdigest()
        )
        self._atomic_write(base_path, base_content)
        self._atomic_write(staged_path, base_content)
        self._atomic_write(
            meta_path,
            json.dumps(
                {
                    "schema_version": 1,
                    "path": relative,
                    "operation": operation,
                    "expected_sha256": expected_sha256,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return self.load(relative)  # type: ignore[return-value]

    def write(self, staged: StagedFile, content: str) -> StagedFile:
        relative = self._relative_path(staged.path)
        staged_path, _base_path, _meta_path = self._paths(relative)
        if staged_path != staged.staged_path:
            raise WorkspaceSecurityError(
                "staging_path_mismatch",
                "The staged file path is inconsistent.",
            )
        self._ensure_safe_directory(staged_path.parent)
        self._atomic_write(staged_path, content)
        updated = self.load(relative)
        if updated is None:
            raise WorkspaceSecurityError(
                "incomplete_staging_entry",
                "The staged file cache is incomplete.",
            )
        return updated

    def cleanup_run(self) -> bool:
        """Remove this run's unreviewed staging tree without following links."""

        if not os.path.lexists(self.root):
            return False
        self._assert_safe_existing_components(self.root)
        if is_link_or_reparse(self.root) or not self.root.is_dir():
            raise WorkspaceSecurityError(
                "invalid_staging_root",
                "The Agent staging root is not a safe directory.",
            )
        for current, directories, files in os.walk(self.root, topdown=False, followlinks=False):
            current_path = Path(current)
            for name in files:
                candidate = current_path / name
                candidate_stat = candidate.lstat()
                if is_link_or_reparse(candidate) or not stat.S_ISREG(candidate_stat.st_mode):
                    raise WorkspaceSecurityError(
                        "invalid_staging_file",
                        "The Agent staging tree contains an unsafe file.",
                    )
                candidate.unlink()
            for name in directories:
                candidate = current_path / name
                if is_link_or_reparse(candidate) or not candidate.is_dir():
                    raise WorkspaceSecurityError(
                        "invalid_staging_directory",
                        "The Agent staging tree contains an unsafe directory.",
                    )
                candidate.rmdir()
        self.root.rmdir()
        try:
            self.root.parent.rmdir()
        except OSError:
            pass
        return True
