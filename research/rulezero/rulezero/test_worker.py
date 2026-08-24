"""Phase 3A S29 gates: GPU worker dry-run (mock/CPU mode)."""
from __future__ import annotations

from pathlib import Path

import pytest

from rulezero.artifacts import ArtifactStore
from rulezero.worker import (
    Job,
    JobController,
    MockWorker,
    WorkerDisconnect,
)


@pytest.fixture()
def store(tmp_path) -> ArtifactStore:
    return ArtifactStore(root=Path(tmp_path) / "artifacts")


def _controller(store, worker=None):
    c = JobController(store, worker_factory=(lambda: worker)
                      if worker else None)
    return c


def test_happy_path_produces_metrics_and_checkpoint(store):
    ctl = _controller(store, MockWorker(steps=4))
    job = ctl.submit("001_kuhn_sft")
    done = ctl.wait(job.id, timeout=10)
    assert done.status == "done"
    assert len(done.metrics) == 4
    assert done.metrics[0]["loss"] > done.metrics[-1]["loss"]
    assert done.artifactId
    # checkpoint artifact round-trips through the real ArtifactStore
    blob = store.get(done.artifactId)
    assert b"001_kuhn_sft" in blob
    assert b"allMetrics" in blob


def test_failed_job_reports_error_and_stops(store):
    def boom(step, job):
        if step == 2:
            raise RuntimeError("injected failure at step 2")
        return {"loss": 1.0}

    ctl = _controller(store, MockWorker(steps=5, step_fn=boom))
    job = ctl.submit("006_rules_ablation")
    done = ctl.wait(job.id, timeout=10)
    assert done.status == "failed"
    assert "step 2" in (done.error or "")
    assert len(done.metrics) == 2


def test_cancel_mid_run(store):
    ctl = _controller(store, MockWorker(steps=2000, step_delay_s=0.002))
    job = ctl.submit("007_search_prior")
    assert ctl.cancel(job.id)
    done = ctl.wait(job.id, timeout=15)
    assert done.status == "cancelled"


def test_disconnect_is_retried_then_succeeds(store):
    ctl = _controller(store, MockWorker(steps=3, disconnect_at=1))
    job = ctl.submit("004_policy_distillation")
    done = ctl.wait(job.id, timeout=10)
    assert done.status == "done"
    assert any("retrying" in ln for ln in done.logs)
    assert done.attempts == 2


def test_disconnect_exhaustion_fails_job(store):
    class AlwaysDrops(MockWorker):
        def run(self, job, store_):  # every attempt drops
            raise WorkerDisconnect("connection reset")

        def __init__(self):  # noqa: D107 - keep signature minimal
            super().__init__(steps=1)

    ctl = _controller(store, AlwaysDrops())
    job = ctl.submit("003_holdout_family")
    done = ctl.wait(job.id, timeout=10)
    assert done.status == "failed"
    assert "reconnect" in (done.error or "")


def test_log_streaming_visible_incrementally(store):
    seen: list[str] = []
    ctl = JobController(
        store, worker_factory=lambda: MockWorker(steps=2, step_delay_s=0.01))
    ctl.log_listeners.append(lambda jid, line: seen.append(line))
    job = ctl.submit("002_multigame_sft")
    ctl.wait(job.id, timeout=10)
    assert any("step 0" in s for s in seen)
    assert any("checkpoint uploaded" in s for s in seen)


def test_cancelled_job_never_uploads_artifact(store):
    ctl = _controller(store, MockWorker(steps=5000, step_delay_s=0.0005))
    job = ctl.submit("005_action_vs_policy")
    ctl.cancel(job.id)
    done = ctl.wait(job.id, timeout=15)
    assert done.status == "cancelled"
    assert not done.artifactId
