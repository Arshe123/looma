"""Exception-safe local index publication; callers must hold the index lock.

Preparation uses a sibling directory on the same filesystem. Publication rolls
back vectors and bookkeeping on failure. This protects in-process failures, not
power loss or concurrent writers in other processes.
"""
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
import shutil
import tempfile


@contextmanager
def staged_index_update(
    persist_dir: Path, record_paths: Sequence[Path], *, copy_existing: bool
) -> Iterator[Path]:
    records = {path: path.read_bytes() if path.exists() else None for path in record_paths}
    persist_dir.parent.mkdir(parents=True, exist_ok=True)
    transaction = Path(tempfile.mkdtemp(prefix=f'.{persist_dir.name}-update-', dir=persist_dir.parent))
    staged = transaction / 'new'
    previous = transaction / 'previous'
    published = False
    preserve_recovery = False
    try:
        if copy_existing and persist_dir.exists():
            shutil.copytree(persist_dir, staged)
        yield staged
        if persist_dir.exists():
            persist_dir.replace(previous)
        if staged.exists():
            staged.replace(persist_dir)
            published = True
    except BaseException:
        try:
            if published and persist_dir.exists():
                shutil.rmtree(persist_dir)
            if previous.exists():
                previous.replace(persist_dir)
            for path, content in records.items():
                if content is None:
                    path.unlink(missing_ok=True)
                elif not path.exists() or path.read_bytes() != content:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(content)
        except BaseException as recovery_error:
            preserve_recovery = True
            raise RuntimeError(f'索引回滚失败，已保留恢复数据：{transaction}') from recovery_error
        raise
    finally:
        if not preserve_recovery:
            shutil.rmtree(transaction)
