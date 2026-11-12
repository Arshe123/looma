"""Explicit per-workspace ignore settings, independent of disposable index data."""
from __future__ import annotations

import json
import unicodedata
from pathlib import Path, PurePosixPath, PureWindowsPath


def ignored_files_path(workspace: Path) -> Path:
    return workspace / ".looma/index/ignored_files.json"


def relative_file_path(value: str | None) -> str:
    relative = (value or "").replace("\\", "/")
    if (not relative or PurePosixPath(relative).is_absolute()
            or PureWindowsPath(relative).drive
            or any(part in {"", ".", ".."} for part in relative.split("/"))):
        raise ValueError("必须提供工作空间内的文件相对路径。")
    return relative


def canonical_relative_file_path(workspace: Path, relative: str) -> str:
    """Use on-disk spelling so case aliases cannot bypass file identity checks."""
    relative = relative_file_path(relative)
    current = workspace
    for part in relative.split("/"):
        entries = list(current.iterdir())
        exact = next((entry for entry in entries if entry.name == part), None)
        if exact is None:
            candidate = current / part
            folded = unicodedata.normalize("NFC", part).casefold()
            exact = next((entry for entry in entries
                          if unicodedata.normalize("NFC", entry.name).casefold() == folded
                          and entry.exists() and entry.samefile(candidate)), None)
        if exact is None:
            raise FileNotFoundError(relative)
        current = exact
    return current.relative_to(workspace).as_posix()


def load_ignored_files(workspace: Path) -> set[str]:
    try:
        payload = json.loads(ignored_files_path(workspace).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return set()
    except json.JSONDecodeError as exc:
        raise ValueError("文件忽略设置已损坏，请检查忽略配置后重试。") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("files"), list):
        raise ValueError("文件忽略设置格式无效。")
    if not all(isinstance(value, str) for value in payload["files"]):
        raise ValueError("文件忽略设置中的路径无效。")
    return {relative_file_path(value) for value in payload["files"]}


def save_ignored_files(workspace: Path, files: set[str]) -> None:
    path = ignored_files_path(workspace)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"files": sorted(files)}, ensure_ascii=False, indent=2), encoding="utf-8")
