"""GPU worker dry-run (Phase 3A S29): the 5090 worker protocol exercised
end-to-end in CPU/mock mode.

controller -> job -> worker -> fake training -> metrics -> checkpoint
artifact. Covers: submit, log streaming, cancel, failure, disconnect
retry. No CUDA anywhere; when the GPU arrives the same JobController
accepts a real worker backend instead of MockWorker.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from .artifacts import ArtifactStore


class WorkerDisconnect(Exception):
    """Simulated transport loss between controller and worker."""


@dataclass
class Job:
    id: str
    experimentId: str
    status: str = "queued"          # queued|running|done|failed|cancelled
    attempts: int = 0
    maxAttempts: int = 3
    error: str | None = None
    metrics: list[dict[str, float]] = field(default_factory=list)
    logs: list[str] = field(default_factory=list)
    artifactId: str | None = None
    cancelRequested: bool = False


# ---------------------------------------------------------------------------
# Mock worker: fake training with injectable behaviour per step
# ---------------------------------------------------------------------------

StepFn = Callable[[int, "Job"], dict[str, float]]


def mock_step(step: int, job: Job) -> dict[str, float]:
    """Default fake train step: loss decays deterministically."""
    if getattr(job, "injectFailAt", None) == step:
        raise RuntimeError(f"injected failure at step {step}")
    return {"loss": round(1.0 / (step + 1), 4), "step": step}


class MockWorker:
    """Runs a fake training loop; `steps` bounds runtime, `disconnectAt`
    raises WorkerDisconnect once to exercise controller retry."""

    def __init__(self, steps: int = 5, disconnect_at: int | None = None,
                 step_fn: StepFn | None = None,
                 step_delay_s: float = 0.0) -> None:
        self.steps = steps
        self.disconnect_at = disconnect_at
        self.step_fn = step_fn or mock_step
        self.step_delay_s = step_delay_s

    def run(self, job: Job, store: ArtifactStore) -> str:
        job.status = "running"
        for step in range(self.steps):
            if job.cancelRequested:
                job.status = "cancelled"
                job.logs.append("cancelled")
                return ""
            try:
                metrics = self.step_fn(step, job)
            except RuntimeError as e:
                job.status = "failed"
                job.error = str(e)
                job.logs.append(f"failed: {e}")
                return ""
            if self.disconnect_at == step and not getattr(
                    self, "_dropped", False):
                self._dropped = True
                job.logs.append("transport lost mid-step")
                raise WorkerDisconnect("connection reset")
            job.metrics.append(metrics)
            job.logs.append(
                f"step {step}: loss={metrics.get('loss', 0):.4f}")
            if self.step_delay_s:
                time.sleep(self.step_delay_s)
        payload = json_bytes({
            "jobId": job.id,
            "experimentId": job.experimentId,
            "finalMetrics": job.metrics[-1] if job.metrics else {},
            "allMetrics": job.metrics,
        })
        art_id = store.put(payload, kind="checkpoint",
                           config_hash=job.experimentId,
                           meta={"worker": "mock"})
        job.artifactId = art_id
        job.status = "done"
        job.logs.append(f"checkpoint uploaded {art_id[:12]}")
        return art_id


def json_bytes(data: Any) -> bytes:
    import json

    return json.dumps(data, sort_keys=True).encode()


# ---------------------------------------------------------------------------
# Controller: bounded queue + retry on disconnect
# ---------------------------------------------------------------------------


class JobController:
    """Minimal task queue (S34): live jobs first-come, one worker thread;
    disconnects are retried up to job.maxAttempts."""

    def __init__(self, store: ArtifactStore, worker_factory: Callable[
        [], MockWorker] | None = None) -> None:
        self.store = store
        self.worker_factory = worker_factory or (lambda: MockWorker())
        self.jobs: dict[str, Job] = {}
        self._cond = threading.Condition()
        self._queue: list[Job] = []
        self._thread: threading.Thread | None = None
        self._shutdown = False
        self.log_listeners: list[Callable[[str, str], None]] = []

    # -- API ------------------------------------------------------------
    def submit(self, experiment_id: str) -> Job:
        job = Job(id=f"job-{uuid.uuid4().hex[:10]}",
                  experimentId=experiment_id)
        self.jobs[job.id] = job
        with self._cond:
            self._queue.append(job)
            self._cond.notify()
        self._ensure_worker()
        return job

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job:
            return False
        job.cancelRequested = True
        return True

    def stream_logs(self, job_id: str) -> list[str]:
        return list(self.jobs[job_id].logs)

    def wait(self, job_id: str, timeout: float = 30.0) -> Job:
        deadline = time.time() + timeout
        while time.time() < deadline:
            job = self.jobs[job_id]
            if job.status in ("done", "failed", "cancelled"):
                return job
            time.sleep(0.02)
        return self.jobs[job_id]

    # -- internals --------------------------------------------------------
    def _ensure_worker(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while not self._shutdown:
            with self._cond:
                if not self._queue:
                    self._cond.wait(timeout=0.1)
                    continue
                job = self._queue.pop(0)
            self._run_with_retry(job)

    def _run_with_retry(self, job: Job) -> None:
        for attempt in range(job.maxAttempts):
            job.attempts = attempt + 1
            before = len(job.logs)
            try:
                self.worker_factory().run(job, self.store)
                for line in job.logs[before:]:
                    self._emit(job.id, line)
                return
            except WorkerDisconnect:
                job.logs.append(f"disconnect; retrying "
                                f"({attempt + 1}/{job.maxAttempts})")
                self._emit(job.id, "disconnect; retrying")
                if attempt == job.maxAttempts - 1:
                    job.status = "failed"
                    job.error = "exhausted reconnect attempts"
                continue
            except Exception as e:  # noqa: BLE001
                job.status = "failed"
                job.error = str(e)
                return

    def _emit(self, job_id: str, line: str) -> None:
        for fn in self.log_listeners:
            fn(job_id, line)
