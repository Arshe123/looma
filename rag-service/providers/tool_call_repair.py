from __future__ import annotations

import json
import re
from typing import Any, AbstractSet


_MAX_ARGUMENT_CHARS = 50_000
_MAX_NAME_CHARS = 256
_MAX_BALANCE_DEPTH = 64

_TEXT_TOOL_BLOCK = re.compile(
    r"<(?:tool_calls?|function_calls?|function|invoke)\b[^>]*>",
    re.IGNORECASE | re.DOTALL,
)


class ToolCallFormatError(ValueError):
    """Sanitized failure for an untrusted provider tool call."""

    def __init__(self, code: str = "invalid_tool_call") -> None:
        self.code = code
        super().__init__(code)


def contains_textual_tool_call(content: Any) -> bool:
    return (
        isinstance(content, str)
        and len(content) <= _MAX_ARGUMENT_CHARS
        and _TEXT_TOOL_BLOCK.search(content) is not None
    )


def repair_tool_name(raw_name: Any, allowed_tools: AbstractSet[str]) -> str | None:
    """Resolve a model-produced name only within the request's dynamic allowlist."""

    if not isinstance(raw_name, str) or not raw_name.strip() or len(raw_name) > _MAX_NAME_CHARS:
        return None
    if not allowed_tools:
        return None

    original = raw_name.strip()
    if original in allowed_tools:
        return original

    casefold_matches = [name for name in allowed_tools if name.casefold() == original.casefold()]
    if len(casefold_matches) == 1:
        return casefold_matches[0]

    snake = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", original)
    snake = re.sub(r"[\s-]+", "_", snake).strip("_").lower()
    candidates = [snake]
    for suffix in ("_tool", "tool"):
        if snake.endswith(suffix):
            candidates.append(snake[: -len(suffix)].rstrip("_"))

    for candidate in candidates:
        if candidate in allowed_tools:
            return candidate

    return None


def parse_tool_arguments(raw_arguments: Any) -> dict[str, Any]:
    """Parse and conservatively repair OpenAI-style function.arguments."""

    if raw_arguments is None:
        return {}
    if isinstance(raw_arguments, dict):
        try:
            rendered = json.dumps(
                raw_arguments,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            )
        except (TypeError, ValueError, OverflowError, RecursionError):
            raise ToolCallFormatError("arguments_not_json") from None
        if len(rendered) > _MAX_ARGUMENT_CHARS:
            raise ToolCallFormatError("arguments_too_large")
        return json.loads(rendered)
    if not isinstance(raw_arguments, str):
        raise ToolCallFormatError("arguments_not_object")

    candidate = raw_arguments.strip()
    if not candidate or candidate == "None":
        return {}
    if len(candidate) > _MAX_ARGUMENT_CHARS:
        raise ToolCallFormatError("arguments_too_large")

    parsed = _load_object(candidate)
    if parsed is not None:
        return parsed

    repaired = _escape_controls_and_remove_trailing_commas(candidate)
    repaired = _balance_json(repaired)
    if repaired is not None:
        repaired = _escape_controls_and_remove_trailing_commas(repaired)
        parsed = _load_object(repaired)
        if parsed is not None:
            return parsed

    trimmed = repaired if repaired is not None else candidate
    for _ in range(8):
        if not trimmed or trimmed[-1] not in "}]":
            break
        trimmed = trimmed[:-1].rstrip()
        parsed = _load_object(trimmed)
        if parsed is not None:
            return parsed

    raise ToolCallFormatError("arguments_invalid_json")


def _load_object(candidate: str) -> dict[str, Any] | None:
    try:
        value = json.loads(candidate)
    except (json.JSONDecodeError, RecursionError, TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _escape_controls_and_remove_trailing_commas(value: str) -> str:
    output: list[str] = []
    in_string = False
    escaped = False
    index = 0
    while index < len(value):
        character = value[index]
        if in_string:
            if escaped:
                escaped = False
                output.append(character)
            elif character == "\\":
                escaped = True
                output.append(character)
            elif character == '"':
                in_string = False
                output.append(character)
            elif ord(character) < 0x20:
                output.append(json.dumps(character)[1:-1])
            else:
                output.append(character)
            index += 1
            continue

        if character == '"':
            in_string = True
            output.append(character)
            index += 1
            continue
        if character == ",":
            lookahead = index + 1
            while lookahead < len(value) and value[lookahead].isspace():
                lookahead += 1
            if lookahead < len(value) and value[lookahead] in "}]":
                index += 1
                continue
        output.append(character)
        index += 1
    return "".join(output)


def _balance_json(value: str) -> str | None:
    stack: list[str] = []
    in_string = False
    escaped = False
    for character in value:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in "[{":
            stack.append(character)
            if len(stack) > _MAX_BALANCE_DEPTH:
                return None
        elif character in "]}":
            if not stack:
                return None
            opener = stack.pop()
            if (opener, character) not in {("[", "]"), ("{", "}")}:
                return None
    if in_string:
        return None
    closers = "".join("}" if opener == "{" else "]" for opener in reversed(stack))
    return value + closers
