# Real Python bridge integration tests

`user-profile-integration.test.ts` runs the actual Python driver, service, tools, and local HTTP bridge. It does not skip Python cases when dependencies are absent.

The test-only `python-driver-runtime.ts` prepares Python in this order:

1. An explicit `RAG_PYTHON` executable (the existing development runtime override). Supply an executable path, not a shell command or arguments. A broken explicit override fails; it does not silently fall back.
2. The service-local `.venv/Scripts/python.exe` on Windows or `.venv/bin/python` elsewhere.
3. `uv run --isolated --python 3.12 --with-requirements looma-agent-service/requirements.txt python`, matching the repository's isolated Python packaging approach and using the official service requirements without adding a test-specific dependency list.

The suite first imports the real driver to surface interpreter/dependency errors and warm caches (180-second process timeout, 200-second setup hook timeout). Each driver run uses the same selected command. In particular, do not retain `sys.executable` from an isolated uv run: uv deletes that temporary environment when the command exits. UTF-8 mode is explicit so piped Chinese fixture content works on Windows.

No global Python packages or repository manifests are modified by this helper. uv needs network access on a cold cache. For offline/restricted environments, prepare a separate virtual environment from `looma-agent-service/requirements.txt` and set `RAG_PYTHON` to its interpreter before running Vitest.

Example in Git Bash on Windows (replace the scratch path if needed):

```bash
mkdir -p 'C:/Users/admin/AppData/Local/hermes/cache/scratch'
export TMPDIR='C:/Users/admin/AppData/Local/hermes/cache/scratch'
export TMP="$TMPDIR" TEMP="$TMPDIR"
export UV_CACHE_DIR="$TMPDIR/looma-test-uv-cache"
npx vitest run src/main/services/agent/test/user-profile-integration.test.ts
```

Optional explicit environment preparation, without modifying global Python:

```bash
uv venv --python 3.12 "$TMPDIR/looma-test-python"
uv pip install --python "$TMPDIR/looma-test-python/Scripts/python.exe" -r looma-agent-service/requirements.txt
export RAG_PYTHON="$TMPDIR/looma-test-python/Scripts/python.exe"
npx vitest run src/main/services/agent/test/user-profile-integration.test.ts
```

On POSIX, use `bin/python` instead of `Scripts/python.exe`. All driver invocations inherit the caller's temporary-directory and cache variables. Keep those directories outside the repository and do not point tests at a real Looma profile or notes directory.
