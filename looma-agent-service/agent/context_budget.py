"""Token accounting for one Agent decision, including the provider's retries."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

from schemas import AgentContextBudget, ChatMessage


class ContextBudgetExceeded(Exception):
    """Required messages cannot fit without changing their meaning or protocol."""


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def local_openai_tokenizer(model: str) -> Callable[[str], list[int]] | None:
    """Use the existing BPE cache, never fetch vocabulary in the request path."""
    try:
        import tiktoken
        from tiktoken.model import encoding_name_for_model
        from tiktoken.registry import ENCODINGS

        name = encoding_name_for_model(model)
        if name in ENCODINGS:
            return ENCODINGS[name].encode_ordinary
        hashes = {
            "cl100k_base": "223921b76ee99bde995b7ff738513eef100fb51d18c93597a113bcffe865b2a7",
            "o200k_base": "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d",
        }
        if name not in hashes:
            return None
        directory = os.environ.get("TIKTOKEN_CACHE_DIR", os.environ.get(
            "DATA_GYM_CACHE_DIR", os.path.join(tempfile.gettempdir(), "data-gym-cache")
        ))
        if not directory:
            return None
        url = f"https://openaipublic.blob.core.windows.net/encodings/{name}.tiktoken"
        path = Path(directory) / hashlib.sha1(url.encode(), usedforsecurity=False).hexdigest()
        if hashlib.sha256(path.read_bytes()).hexdigest() == hashes[name]:
            return tiktoken.get_encoding(name).encode_ordinary
    except (ImportError, OSError, KeyError, ValueError):
        pass
    return None


def history_groups(history: list[ChatMessage]) -> list[list[ChatMessage]]:
    """Keep whole historical turns and discard incomplete native tool exchanges."""
    turns: list[list[ChatMessage]] = []
    turn: list[ChatMessage] = []
    index = 0
    while index < len(history):
        message = history[index]
        index += 1
        if message.role == "tool":
            continue  # orphaned result
        if message.role in {"user", "system"} and turn:
            turns.append(turn)
            turn = []
        if message.role == "assistant" and message.tool_calls:
            results = []
            while index < len(history) and history[index].role == "tool":
                results.append(history[index])
                index += 1
            ids = {call.id for call in message.tool_calls}
            if len(ids) != len(message.tool_calls) or len(results) != len(ids) or {
                result.tool_call_id for result in results
            } != ids:
                continue
            turn.extend([message, *results])
        else:
            turn.append(message)
    if turn:
        turns.append(turn)
    return turns


_Message = TypeVar("_Message", ChatMessage, dict[str, Any])


def _wire(message: _Message) -> dict[str, Any]:
    return message if isinstance(message, dict) else message.model_dump(exclude_none=True)


# Preserve complete revision-checked documents and the file patch's staged
# versus applied state; a generic success flag is not sufficient for these.
_UNCOMPACTABLE_TOOLS = {
    "user_profile_read", "user_profile_update", "workspace_memory_read", "workspace_memory_update", "file_patch",
}


def _compact_observation(message: _Message) -> _Message:
    payload = _wire(message)
    if payload["role"] != "tool" or (payload.get("name") or payload.get("tool_name")) in _UNCOMPACTABLE_TOOLS:
        return message
    try:
        result = json.loads(payload.get("content") or "")
    except (ValueError, TypeError):
        return message
    if not isinstance(result, dict) or "modelContext" not in result:
        return message
    result["modelContext"] = {"facts": [], "structuredData": {"omittedForContextBudget": True}}
    result["truncated"] = True
    content = compact_json(result)
    if isinstance(message, dict):
        return {**message, "content": content}
    return message.model_copy(update={"content": content})


@dataclass
class RequestBudget:
    settings: AgentContextBudget
    has_memory: bool
    history_lengths: list[int]
    trace_lengths: list[int]
    emit: Callable[[dict[str, Any]], None]
    tokenizer: Callable[[str], list[int]] | None = None
    output_tokens: int | None = None

    def count(self, text: str) -> int:
        if self.tokenizer is not None:
            return len(self.tokenizer(text))
        # Use a higher weight for non-ASCII to account for multilingual text;
        # this still cannot know the model's actual vocabulary or chat template.
        if text.isascii():
            return (len(text) + 2) // 3
        extra_bytes = len(text.encode("utf-8", errors="replace")) - len(text)
        return (len(text) + 2) // 3 + extra_bytes

    def fit(
        self,
        messages: list[_Message],
        *,
        tools: Any = None,
        embedded_tools: bool = False,
        provider_window: int | None = None,
        default_output: int = 4096,
        configured_output: int | None = None,
        system_overhead: int = 12,
        allocate: Callable[[int], int] | None = None,
    ) -> tuple[list[_Message], int]:
        window = self.settings.context_window_tokens
        if provider_window is not None:
            window = min(window, provider_window)
        maxima = [v for v in (configured_output, self.settings.max_output_tokens) if v is not None]
        # Small windows should not lose most of their space to a fallback reserve.
        output = min(maxima) if maxima else min(default_output, max(1, window // 4))
        self.output_tokens = min(output, max(1, window - 1))
        input_limit = window - self.output_tokens
        if self.settings.max_input_tokens is not None:
            input_limit = min(input_limit, self.settings.max_input_tokens)

        # Provider adapters merge the protocol into the first system message.
        # Everything they append (final-only/repair instructions) follows traces.
        history_start = 1 + int(self.has_memory)
        history_count = sum(self.history_lengths)
        trace_start = history_start + history_count + 2
        trace_count = sum(self.trace_lengths)
        tail_start = trace_start + trace_count

        counts = [self.count(compact_json(_wire(message))) + 4 for message in messages]
        tools_count = self.count(compact_json(tools)) if tools else 0
        used_input = sum(counts) + system_overhead + (0 if embedded_tools else tools_count)
        keep = [True] * len(messages)
        replacements: dict[int, _Message] = {}

        def remove(start: int, length: int) -> None:
            nonlocal used_input
            for pos in range(start, start + length):
                if keep[pos]:
                    keep[pos] = False
                    used_input -= counts[pos]

        # Evict oldest complete history turns, then old current-run tool batches.
        for start, lengths in ((history_start, self.history_lengths), (trace_start, self.trace_lengths[:-1])):
            for length in lengths:
                if used_input <= input_limit:
                    break
                remove(start, length)
                start += length
        if used_input > input_limit:
            # Drop optional invalid-response examples before required repair prompts.
            for pos in range(tail_start, len(messages)):
                if _wire(messages[pos])["role"] == "assistant":
                    remove(pos, 1)
        if used_input > input_limit and self.trace_lengths:
            # Keep the latest call batch, IDs, arguments, reasoning and all result
            # envelopes; only its replaceable observation data may be compacted.
            positions = range(tail_start - self.trace_lengths[-1] + 1, tail_start)
            for pos in sorted(positions, key=counts.__getitem__, reverse=True):
                replacement = _compact_observation(messages[pos])
                if replacement is messages[pos]:
                    continue
                replacement_count = self.count(compact_json(_wire(replacement))) + 4
                if replacement_count < counts[pos]:
                    replacements[pos] = replacement
                    used_input -= counts[pos] - replacement_count
                    counts[pos] = replacement_count
                if used_input <= input_limit:
                    break
        if used_input > input_limit and self.has_memory:
            remove(1, 1)
        if used_input > input_limit:
            raise ContextBudgetExceeded

        parts = {
            "system": system_overhead,
            "memory": 0,
            "history": 0,
            "input": 0,
            "tools": 0 if embedded_tools else tools_count,
            "outputReserve": self.output_tokens,
        }
        labels = ["system"] + ["memory"] * int(self.has_memory) + ["history"] * history_count
        labels += ["system", "input"] + ["tools"] * trace_count + ["system"] * (len(messages) - tail_start)
        for pos, (label, count) in enumerate(zip(labels, counts)):
            if keep[pos]:
                parts[label] += count
        if embedded_tools:
            # The JSON decision protocol already contains the schemas. Reattribute
            # their approximate share rather than increasing total usage twice.
            shifted = min(parts["system"], tools_count)
            parts["system"] -= shifted
            parts["tools"] += shifted
        used = used_input + self.output_tokens
        actual_window = min(window, allocate(used)) if allocate else window
        # Even with a content tokenizer, server chat-template/tool framing is estimated.
        self.emit({"limitTokens": actual_window, "usedTokens": used, "estimated": True, "parts": parts})
        return [replacements.get(i, msg) for i, msg in enumerate(messages) if keep[i]], actual_window


active_budget: ContextVar[RequestBudget | None] = ContextVar("agent_request_budget", default=None)
