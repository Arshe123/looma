import re
from pathlib import Path
from typing import Any


_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:")


class WorkspaceSecurityError(ValueError):
    """Stable, caller-safe error raised for workspace boundary violations."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def resolve_workspace_path(
    workspace_path: str | Path,
    relative_path: Any,
    *,
    allow_internal: bool = False,
    must_exist: bool = False,
) -> Path:
    """Resolve a user path while keeping it inside a real workspace directory."""

    try:
        workspace = Path(workspace_path).resolve(strict=True)
    except (OSError, RuntimeError, TypeError, ValueError):
        raise WorkspaceSecurityError(
            "workspace_invalid", "Workspace must be an existing directory."
        ) from None
    if not workspace.is_dir():
        raise WorkspaceSecurityError(
            "workspace_invalid", "Workspace must be an existing directory."
        )

    if not isinstance(relative_path, str) or not relative_path.strip() or "\x00" in relative_path:
        raise WorkspaceSecurityError(
            "workspace_path_invalid", "Workspace path must be a non-empty relative path."
        )

    normalized = relative_path.replace("\\", "/")
    if normalized.startswith("/") or _WINDOWS_DRIVE.match(normalized):
        raise WorkspaceSecurityError(
            "workspace_path_absolute", "Absolute workspace paths are not allowed."
        )

    parts = normalized.split("/")
    if ".." in parts:
        raise WorkspaceSecurityError(
            "workspace_path_escape", "Workspace path escapes the workspace boundary."
        )
    if not allow_internal and any(part.casefold() == ".looma" for part in parts):
        raise WorkspaceSecurityError(
            "workspace_internal_path", "Internal .looma paths are not accessible."
        )

    try:
        target = workspace.joinpath(*parts).resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        raise WorkspaceSecurityError(
            "workspace_path_invalid", "Workspace path could not be resolved."
        ) from None

    if target != workspace and workspace not in target.parents:
        raise WorkspaceSecurityError(
            "workspace_path_escape", "Workspace path escapes the workspace boundary."
        )
    relative_target_parts = target.relative_to(workspace).parts
    if not allow_internal and any(
        part.casefold() == ".looma" for part in relative_target_parts
    ):
        raise WorkspaceSecurityError(
            "workspace_internal_path", "Internal .looma paths are not accessible."
        )
    if must_exist and not target.exists():
        raise WorkspaceSecurityError(
            "workspace_target_missing", "Workspace target does not exist."
        )
    return target
