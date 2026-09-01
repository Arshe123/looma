from __future__ import annotations

import multiprocessing
import os
import sys

import uvicorn

from main import app


def run_packaging_self_test() -> None:
    """Verify dynamically discovered runtime dependencies in the frozen app."""
    import tiktoken
    from rag.index_service import make_node_transformations
    from schemas import KnowledgeConfig

    encoding = tiktoken.get_encoding("cl100k_base")
    if not encoding.encode("Looma 索引打包自检"):
        raise RuntimeError("cl100k_base tokenizer returned no tokens")

    transformations = make_node_transformations(
        KnowledgeConfig(chunking_strategy="fixed", chunk_size=128, chunk_overlap=16)
    )
    sample = "第一句。Second sentence. " * 100
    if len(transformations[0].split_text(sample)) < 2:
        raise RuntimeError("sentence splitter packaging self-test returned too few chunks")


def main() -> None:
    if "--packaging-self-test" in sys.argv[1:]:
        run_packaging_self_test()
        return

    port = int(os.environ.get("RAG_SERVICE_PORT", "8765"))
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        log_level=os.environ.get("RAG_SERVICE_LOG_LEVEL", "warning"),
        access_log=False,
    )


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
