"""Artifact store (§19): Git stays small; trajectories/datasets/checkpoints
live here with full provenance. Local filesystem now, S3-compatible later
(same interface).

Every artifact: artifactId (= SHA-256 of content), producing commit,
config hash, parent artifacts, timestamp. Raw trajectories are immutable —
storing the same artifactId twice is a no-op; storing an id with different
bytes is an error.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import time
from pathlib import Path
from typing import Any


def _git_commit() -> str:
    try:
        return (
            subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True, text=True, timeout=5,
            ).stdout.strip() or "unknown"
        )
    except Exception:
        return "unknown"


class ArtifactStore:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)
        (self.root / "blobs").mkdir(parents=True, exist_ok=True)
        (self.root / "manifests").mkdir(parents=True, exist_ok=True)

    # -- internals ---------------------------------------------------------

    @staticmethod
    def _digest(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    def _blob_path(self, artifact_id: str) -> Path:
        return self.root / "blobs" / artifact_id

    def _manifest_path(self, artifact_id: str) -> Path:
        return self.root / "manifests" / f"{artifact_id}.json"

    # -- API ---------------------------------------------------------------

    def put(
        self,
        data: bytes,
        kind: str,
        config_hash: str = "",
        parents: list[str] | None = None,
        meta: dict[str, Any] | None = None,
    ) -> str:
        """Store bytes immutably; returns the artifactId."""
        artifact_id = self._digest(data)
        blob = self._blob_path(artifact_id)
        if blob.exists():
            if blob.read_bytes() != data:  # pragma: no cover - sha collision
                raise ValueError(f"artifactId collision for {artifact_id}")
            return artifact_id  # idempotent: same bytes already stored

        tmp = blob.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(blob)  # atomic publish after fully written

        manifest = {
            "artifactId": artifact_id,
            "kind": kind,
            "size": len(data),
            "producingCommit": _git_commit(),
            "configHash": config_hash,
            "parents": parents or [],
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "meta": meta or {},
        }
        self._manifest_path(artifact_id).write_text(json.dumps(manifest, indent=2))
        return artifact_id

    def put_json(self, obj: Any, **kwargs: Any) -> str:
        return self.put(
            json.dumps(obj, sort_keys=True).encode(), **kwargs
        )

    def get(self, artifact_id: str) -> bytes:
        blob = self._blob_path(artifact_id)
        if not blob.exists():
            raise KeyError(f"unknown artifact {artifact_id}")
        return blob.read_bytes()

    def get_json(self, artifact_id: str) -> Any:
        return json.loads(self.get(artifact_id))

    def manifest(self, artifact_id: str) -> dict[str, Any]:
        p = self._manifest_path(artifact_id)
        if not p.exists():
            raise KeyError(f"no manifest for {artifact_id}")
        return json.loads(p.read_text())

    def has(self, artifact_id: str) -> bool:
        return self._blob_path(artifact_id).exists()
