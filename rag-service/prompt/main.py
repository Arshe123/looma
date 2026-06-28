from __future__ import annotations

from typing import Any, Mapping

BASE_SYSTEM_PROMPT = """
你是 Looma 的本地笔记助手，负责根据用户的笔记资料和对话上下文回答问题。

你必须遵守以下规则：
1. 优先依据提供的【检索资料】回答。
2. 如果检索资料不足以回答问题，请明确说明“资料中没有足够信息”。
3. 不要编造笔记中不存在的事实。
4. 可以结合历史对话理解用户意图，但不要把历史对话当作事实来源。
5. 默认使用中文回答。
6. 回答要清晰、准确、简洁。
7. 如果引用资料，请使用“根据资料 1 / 资料 2”这种方式标明依据。
""".strip()

NO_CONTEXT_PROMPT = """
以下是从用户笔记中检索到的资料。

【检索资料】
没有检索到相关资料。

回答规则：
1. 如果没有资料可以回答，请直接说明资料中没有足够信息。
2. 不要编造不存在的内容。
""".strip()


def _get_value(doc: Any, key: str, default: Any = None) -> Any:
    """Read a value from either a dict-style source or an object-style source.

    当前 RAG 检索链路传给 prompt 的 doc 通常是 dict：
    {
        "score": float | None,
        "text": str,
        "metadata": {
            "source": str,       # 工作空间相对路径，优先用于展示
            "file_path": str,    # 绝对文件路径
            "path": str,         # 工作空间相对路径
            "extension": str,
            ...
        }
    }

    为了兼容 LlamaIndex NodeWithScore / TextNode，也支持属性读取：
    doc.score / doc.text / doc.metadata / doc.get_content(...)
    """
    if isinstance(doc, Mapping):
        return doc.get(key, default)
    return getattr(doc, key, default)


def _get_metadata(doc: Any) -> dict[str, Any]:
    metadata = _get_value(doc, "metadata", {})
    if isinstance(metadata, Mapping):
        return dict(metadata)
    return {}


def _get_doc_text(doc: Any) -> str:
    text = _get_value(doc, "text")
    if isinstance(text, str) and text.strip():
        return text.strip()

    content = _get_value(doc, "content")
    if isinstance(content, str) and content.strip():
        return content.strip()

    get_content = getattr(doc, "get_content", None)
    if callable(get_content):
        try:
            return str(get_content(metadata_mode="none")).strip()
        except TypeError:
            return str(get_content()).strip()

    return ""


def _get_doc_path(doc: Any, metadata: dict[str, Any]) -> str:
    path = (
        metadata.get("source")
        or metadata.get("path")
        or metadata.get("file_path")
        or _get_value(doc, "path")
        or _get_value(doc, "file_path")
        or ""
    )
    return str(path).strip() if path else "未知"


def _format_score(score: Any) -> str:
    if score is None:
        return "未知"
    if isinstance(score, (int, float)):
        return f"{score:.4f}"
    return str(score)


def _format_metadata(metadata: dict[str, Any]) -> str:
    if not metadata:
        return "无"

    allowed_keys = ["source", "path", "extension", "title", "name"]
    parts = []
    for key in allowed_keys:
        value = metadata.get(key)
        if value not in (None, ""):
            parts.append(f"{key}={value}")
    return "；".join(parts) if parts else "无"


def build_rag_context_prompt(docs: list[dict[str, Any]] | list[Any]) -> str:
    if not docs:
        return NO_CONTEXT_PROMPT

    parts: list[str] = []

    for i, doc in enumerate(docs, start=1):
        metadata = _get_metadata(doc)
        text = _get_doc_text(doc)
        path = _get_doc_path(doc, metadata)
        score = _get_value(doc, "score")
        metadata_text = _format_metadata(metadata)

        parts.append(f"""
[资料 {i}]
路径：{path}
相关度：{_format_score(score)}
元数据：{metadata_text}
内容：
{text or "（空片段）"}
""".strip())

    joined_docs = "\n\n".join(parts)

    return f"""
以下是从用户笔记中检索到的资料。你需要优先依据这些资料回答用户问题。

【检索资料】
{joined_docs}

回答规则：
1. 如果资料可以回答问题，请基于资料回答。
2. 如果资料不足，请明确说明资料中没有足够信息。
3. 不要编造资料中没有的事实。
4. 如果使用了资料，可以用“根据资料 1 / 资料 2”说明依据。
5. 不要输出完整文件路径中的敏感信息；需要引用位置时优先使用“路径”里的工作空间相对路径。
""".strip()
