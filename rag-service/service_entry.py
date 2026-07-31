from __future__ import annotations

import multiprocessing
import os

import uvicorn

from main import app


def main() -> None:
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
