from __future__ import annotations

import os
import stat
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from agent.security import WorkspaceSecurityError, resolve_workspace_path


IGNORED_DIRECTORIES = frozenset({".git", "node_modules", "dist", "out", ".looma"})
MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024
MAX_SCAN_ENTRIES = 20_000


@dataclass
class ScanBudget:
    remaining: int = MAX_SCAN_ENTRIES
    exhausted: bool = False


def relative_posix(workspace: Path, path: Path) -> str:
    relative = path.relative_to(workspace)
    return "." if not relative.parts else relative.as_posix()


def observation_path(value: str) -> str:
    normalized = value.replace("\\", "/")
    while "//" in normalized:
        normalized = normalized.replace("//", "/")
    return normalized or "."


def is_link_or_reparse(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        attributes = getattr(path.lstat(), "st_file_attributes", 0)
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        return bool(reparse_flag and attributes & reparse_flag)
    except OSError:
        return True


def open_regular_no_follow(path: Path) -> int | None:
    """Best-effort race-resistant open of an ordinary, non-reparse file."""

    descriptor = -1
    try:
        before = os.lstat(path)
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        if stat.S_ISLNK(before.st_mode) or (
            reparse_flag and getattr(before, "st_file_attributes", 0) & reparse_flag
        ):
            return None
        if not stat.S_ISREG(before.st_mode):
            return None

        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        after = os.fstat(descriptor)
        if not stat.S_ISREG(after.st_mode):
            return None

        for identity_field in ("st_dev", "st_ino"):
            before_value = getattr(before, identity_field, None)
            after_value = getattr(after, identity_field, None)
            if before_value is not None and after_value is not None and before_value != after_value:
                return None

        result = descriptor
        descriptor = -1
        return result
    except OSError:
        return None
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass


def resolve_no_follow_workspace_path(
    workspace_path: str | Path,
    relative_path: str,
    *,
    must_exist: bool = False,
) -> Path:
    """Resolve a user path and reject every existing link/reparse component."""

    workspace = resolve_workspace_path(workspace_path, ".", must_exist=True)
    resolution_error: WorkspaceSecurityError | None = None
    try:
        target = resolve_workspace_path(workspace_path, relative_path)
    except WorkspaceSecurityError as exc:
        resolution_error = exc
        target = None

    if not isinstance(relative_path, str):
        assert resolution_error is not None
        raise resolution_error

    normalized = relative_path.replace("\\", "/")
    current = workspace
    for part in normalized.split("/"):
        if part in ("", "."):
            continue
        current = current / part
        if os.path.lexists(current) and is_link_or_reparse(current):
            raise WorkspaceSecurityError(
                "workspace_link_not_allowed",
                "Links and reparse points are not allowed in workspace paths.",
            )

    if resolution_error is not None:
        raise resolution_error
    assert target is not None
    return resolve_workspace_path(workspace_path, relative_path, must_exist=must_exist)


def sorted_directory_entries(
    directory: Path, budget: ScanBudget
) -> list[os.DirEntry[str]] | None:
    try:
        with os.scandir(directory) as iterator:
            entries: list[os.DirEntry[str]] = []
            for entry in iterator:
                if budget.remaining <= 0:
                    budget.exhausted = True
                    break
                budget.remaining -= 1
                entries.append(entry)
    except OSError:
        return None
    return sorted(entries, key=lambda entry: (entry.name.casefold(), entry.name))


def iter_workspace_files(workspace: Path, budget: ScanBudget) -> Iterator[Path]:
    """Yield ordinary files in stable path order without following reparse points."""

    stack: list[tuple[Path, Iterator[os.DirEntry[str]]]] = []
    root_entries = sorted_directory_entries(workspace, budget)
    if root_entries is None:
        return
    stack.append((workspace, iter(root_entries)))

    while stack:
        _directory, entries = stack[-1]
        try:
            entry = next(entries)
        except StopIteration:
            stack.pop()
            continue

        path = Path(entry.path)
        if is_link_or_reparse(path):
            continue
        try:
            if entry.is_dir(follow_symlinks=False):
                if entry.name.casefold() in IGNORED_DIRECTORIES:
                    continue
                if budget.remaining <= 0:
                    budget.exhausted = True
                    continue
                children = sorted_directory_entries(path, budget)
                if children is not None:
                    stack.append((path, iter(children)))
            elif entry.is_file(follow_symlinks=False):
                yield path
        except OSError:
            continue
