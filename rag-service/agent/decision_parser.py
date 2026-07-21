import json
import math
import re
from typing import AbstractSet, Any, Sequence, get_args

from pydantic import ValidationError

from agent.models import AgentDecision, AgentToolCall, parse_agent_decision
from schemas import ChatMessage, ToolName


_MAX_TOOL_SCHEMAS_CHARS = 50_000
_MAX_DECISION_RESPONSE_CHARS = 50_000
_MAX_JSON_DEPTH = 64
_MAX_JSON_NODES = 10_000
_FENCED_JSON = re.compile(r"\A```(?:json)?\s*\n?(.*?)\n?```\Z", re.IGNORECASE | re.DOTALL)
_CANONICAL_TOOL_NAMES = frozenset(get_args(ToolName))


class AgentDecisionParseError(ValueError):
    """A sanitized, retryable failure to parse a structured agent decision."""

    code = "invalid_agent_decision"
    retryable = True

    def __init__(self) -> None:
        super().__init__("Invalid structured agent decision")


class AgentEmptyDecisionError(AgentDecisionParseError):
    """The provider completed without any public decision content."""

    code = "empty_agent_decision"

    def __init__(self) -> None:
        ValueError.__init__(self, "Empty structured agent decision")


def parse_agent_decision_text(
    text: str, allowed_tools: AbstractSet[str] | None = None
) -> AgentDecision:
    """Parse a complete JSON response and optionally enforce a runtime tool allowlist."""
    if not isinstance(text, str) or not text.strip():
        raise AgentEmptyDecisionError()
    if len(text) > _MAX_DECISION_RESPONSE_CHARS:
        raise AgentDecisionParseError()

    candidate = text.strip()
    fenced = _FENCED_JSON.fullmatch(candidate)
    if fenced is not None:
        candidate = fenced.group(1).strip()
        if not candidate:
            raise AgentDecisionParseError()

    if not _json_structure_within_budget(candidate):
        raise AgentDecisionParseError()

    try:
        value = json.loads(candidate)
        if not isinstance(value, dict):
            raise ValueError("decision must be an object")
        decision = parse_agent_decision(value)
        if (
            allowed_tools is not None
            and isinstance(decision, AgentToolCall)
            and decision.tool not in allowed_tools
        ):
            raise ValueError("tool is not available for this request")
        return decision
    except (json.JSONDecodeError, ValidationError, RecursionError, TypeError, ValueError):
        pass

    # Raise outside the exception handler so the sanitized error does not retain
    # the parser/validation exception (which may include raw model fragments).
    raise AgentDecisionParseError()


def _json_structure_within_budget(value: str) -> bool:
    """Bound nesting/member work before handing untrusted text to json.loads."""

    depth = 0
    nodes = 0
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
            depth += 1
            nodes += 1
            if depth > _MAX_JSON_DEPTH or nodes > _MAX_JSON_NODES:
                return False
        elif character in "]}":
            depth -= 1
        elif character == ",":
            nodes += 1
            if nodes > _MAX_JSON_NODES:
                return False
    return True


def _escaped_json_string_chars(value: str) -> int:
    total = 2
    for character in value:
        codepoint = ord(character)
        if character in ('"', "\\"):
            total += 2
        elif codepoint < 0x20:
            total += 6
        else:
            total += 1
        if total > _MAX_TOOL_SCHEMAS_CHARS:
            raise ValueError("string exceeds schema budget")
    return total


def _preflight_tool_schemas(tool_schemas: list[dict[str, Any]]) -> None:
    """Validate JSON shape and resource budgets without recursive traversal."""

    stack: list[tuple[Any, int]] = [(tool_schemas, 0)]
    seen_containers: set[int] = set()
    nodes = 0
    estimated_chars = 0

    while stack:
        value, depth = stack.pop()
        nodes += 1
        if nodes > _MAX_JSON_NODES or depth > _MAX_JSON_DEPTH:
            raise ValueError("schema structure exceeds budget")

        if isinstance(value, dict):
            identity = id(value)
            if identity in seen_containers or len(value) > _MAX_JSON_NODES - nodes:
                raise ValueError("invalid or oversized schema object")
            seen_containers.add(identity)
            estimated_chars += 2 + max(0, len(value) - 1) + len(value)
            for key, item in value.items():
                if not isinstance(key, str):
                    raise ValueError("schema object keys must be strings")
                estimated_chars += _escaped_json_string_chars(key)
                stack.append((item, depth + 1))
        elif isinstance(value, list):
            identity = id(value)
            if identity in seen_containers or len(value) > _MAX_JSON_NODES - nodes:
                raise ValueError("invalid or oversized schema array")
            seen_containers.add(identity)
            estimated_chars += 2 + max(0, len(value) - 1)
            stack.extend((item, depth + 1) for item in value)
        elif isinstance(value, str):
            estimated_chars += _escaped_json_string_chars(value)
        elif value is None:
            estimated_chars += 4
        elif isinstance(value, bool):
            estimated_chars += 4 if value else 5
        elif isinstance(value, int):
            if value.bit_length() > 4096:
                raise ValueError("integer exceeds schema budget")
            estimated_chars += len(str(value))
        elif isinstance(value, float):
            if not math.isfinite(value):
                raise ValueError("schema number must be finite")
            estimated_chars += len(repr(value))
        else:
            raise ValueError("schema contains a non-JSON value")

        if len(stack) > _MAX_JSON_NODES:
            raise ValueError("schema traversal exceeds budget")
        if estimated_chars > _MAX_TOOL_SCHEMAS_CHARS:
            raise ValueError("schema serialization exceeds budget")


def _serialize_and_validate_tool_schemas(
    tool_schemas: Any,
) -> tuple[str, frozenset[str]]:
    """Validate runtime schemas once and derive prompt JSON plus the exact allowlist."""

    try:
        if not isinstance(tool_schemas, list):
            raise ValueError("not a list")

        # Enforce shape and resource budgets before hashing, trimming, or otherwise
        # processing any untrusted schema field (including a potentially huge name).
        _preflight_tool_schemas(tool_schemas)

        allowed_tools: set[str] = set()
        for schema in tool_schemas:
            if not isinstance(schema, dict):
                raise ValueError("schema item is not an object")
            name = schema.get("name")
            if (
                not isinstance(name, str)
                or not name.strip()
                or name not in _CANONICAL_TOOL_NAMES
                or name in allowed_tools
            ):
                raise ValueError("invalid schema name")
            allowed_tools.add(name)

        serialized_tools = json.dumps(
            tool_schemas,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        )
        if len(serialized_tools) > _MAX_TOOL_SCHEMAS_CHARS:
            raise ValueError("schemas too large")
        return serialized_tools, frozenset(allowed_tools)
    except (TypeError, ValueError, OverflowError, RecursionError):
        pass

    # Keep all schema values and serializer details out of validation errors.
    raise ValueError("Invalid tool_schemas")


def prepare_native_tool_schemas(
    tool_schemas: Any,
) -> tuple[list[dict[str, Any]], frozenset[str]]:
    """Validate Looma schemas and convert them to OpenAI function-tool envelopes."""

    serialized_tools, allowed_tools = _serialize_and_validate_tool_schemas(tool_schemas)
    decoded = json.loads(serialized_tools)
    native_tools: list[dict[str, Any]] = []
    for schema in decoded:
        description = schema.get("description")
        parameters = schema.get("parameters", {"type": "object", "properties": {}})
        if description is not None and not isinstance(description, str):
            raise ValueError("Invalid tool_schemas")
        if not isinstance(parameters, dict):
            raise ValueError("Invalid tool_schemas")
        function = {
            "name": schema["name"],
            "parameters": parameters,
        }
        if description:
            function["description"] = description
        native_tools.append({"type": "function", "function": function})
    return native_tools, allowed_tools


def _build_messages_from_serialized_tools(
    messages: Sequence[ChatMessage], serialized_tools: str
) -> list[ChatMessage]:
    protocol = (
        "你是结构化 Agent 决策器。仅输出一个 JSON（json）object；禁止 Markdown、代码围栏、"
        "解释性 prose、chain-of-thought 和 DSML。只允许以下两种形状，字段必须完全匹配：\n"
        '{"type":"tool_call","thought_summary":"一条不超过500字符、可展示的简短摘要",'
        '"tool":"可用工具名","arguments":{}}\n'
        '或 {"type":"final","answer":"给用户的最终答案"}\n'
        "调用工具时 type 必须严格为 tool_call，type 绝不能填写工具名；工具名只放在 tool 字段。"
        "thought_summary 不是隐藏推理，不得输出详细思维过程。tool 必须来自下方运行时可用工具，"
        "arguments 必须符合对应 schema。运行时可用工具 JSON：\n"
        + serialized_tools
    )
    return [ChatMessage(role="system", content=protocol), *list(messages)]


def prepare_agent_decision_messages(
    messages: Sequence[ChatMessage], tool_schemas: Any
) -> tuple[list[ChatMessage], frozenset[str]]:
    """Build the prompt and return the allowlist derived from the same validation pass."""

    serialized_tools, allowed_tools = _serialize_and_validate_tool_schemas(tool_schemas)
    return _build_messages_from_serialized_tools(messages, serialized_tools), allowed_tools


def build_agent_decision_messages(
    messages: Sequence[ChatMessage], tool_schemas: Any
) -> list[ChatMessage]:
    """Prepend a strict provider-neutral decision protocol and runtime tool schemas."""

    prompted_messages, _ = prepare_agent_decision_messages(messages, tool_schemas)
    return prompted_messages
