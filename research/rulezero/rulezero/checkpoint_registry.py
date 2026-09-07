"""Content-addressed policy registry. Only registry IDs cross the web boundary."""
from __future__ import annotations
import json
import os
from pathlib import Path
import uuid
from .artifacts import ArtifactStore
from .gamespec_runtime import RUNTIME_VERSION


def registry_root():
    path = Path(os.environ.get('RULEZERO_CHECKPOINTS', Path(__file__).resolve().parent.parent / 'artifacts' / 'learning'))
    path.mkdir(parents=True, exist_ok=True)
    return path


def register_checkpoint(backend, *, run_id: str, generation: int, metrics: dict, parent=None, promoted=False):
    root = registry_root()
    store = ArtifactStore(root)
    temp = root / f'{uuid.uuid4().hex}.pt'
    try:
        backend.save(temp)
        artifact_id = store.put(temp.read_bytes(), kind='checkpoint', parents=[parent] if parent else [],
                                meta={'runId': run_id, 'generation': generation, 'runtimeVersion': RUNTIME_VERSION})
    finally:
        temp.unlink(missing_ok=True)
    record = {'id': artifact_id, 'runId': run_id, 'generation': generation,
              'metrics': metrics, 'promoted': promoted, 'runtimeVersion': RUNTIME_VERSION,
              'renderer': backend.metadata().renderer, 'backend': backend.metadata().backend_kind}
    path = root / (artifact_id + '.json')
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(record, allow_nan=False))
    os.replace(tmp, path)
    return record


def list_checkpoints():
    return [json.loads(p.read_text()) for p in sorted(registry_root().glob('*.json')) if len(p.stem) == 64]


def load_checkpoint(checkpoint_id):
    if len(checkpoint_id) != 64 or any(c not in '0123456789abcdef' for c in checkpoint_id):
        raise ValueError('invalid checkpoint id')
    root = registry_root()
    record = json.loads((root / (checkpoint_id + '.json')).read_text())
    if record['runtimeVersion'] != RUNTIME_VERSION:
        raise ValueError('checkpoint runtime is incompatible')
    from .backends import get_backend
    backend = get_backend(record['backend'])
    backend.load(root / 'blobs' / checkpoint_id)
    return backend
