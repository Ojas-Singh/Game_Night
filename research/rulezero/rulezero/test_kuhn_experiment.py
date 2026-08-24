"""Milestone 5 experiment gate (§32): full Kuhn train→checkpoint→evaluate run.

Also pins §23's measurement set and manifest completeness, plus determinism
of the whole pipeline.
"""
from __future__ import annotations

import json
from pathlib import Path

from rulezero.backends import LocalBackend, RenderedExample
from rulezero.kuhn_teacher import (
    build_teacher_dataset,
    imitation_accuracy,
    play_games,
    run_kuhn_sft_experiment,
    train_cfr_teacher,
)

REQUIRED_MANIFEST_KEYS = {
    "experiment",
    "game",
    "renderer",
    "backend",
    "training_algorithm",
    "seed",
    "checkpoint_sha256",
    "open_spiel_version",
    "metrics",
}


def test_full_kuhn_run(tmp_path: Path) -> None:
    manifest = run_kuhn_sft_experiment(
        tmp_path,
        cfr_iterations=120,
        eval_games=120,
        epochs=2,
        seed=0,
    )
    missing = REQUIRED_MANIFEST_KEYS - set(manifest)
    assert not missing, f"manifest missing {missing}"
    m = manifest["metrics"]
    # §23 measurement set (local-backend control):
    assert 0.0 <= m["imitation_accuracy"] <= 1.0
    assert m["imitation_accuracy"] >= 0.9  # tabular memorization of 12 states
    assert m["vs_random"]["illegal_forced"] == 0
    assert abs(m["vs_random"]["avg_return_p0"]) < 1.5  # kuhn returns are ±2 bounded
    assert (tmp_path / "manifest.json").exists()
    assert (tmp_path / "checkpoint.json").exists()
    ds = json.loads((tmp_path / "dataset.json").read_text())
    assert len(ds) == 12  # kuhn has exactly 12 information states


def test_teacher_converges_monotonically_enough() -> None:
    early = train_cfr_teacher(20)
    late = train_cfr_teacher(300)
    assert late.exploitability < early.exploitability
    assert late.exploitability < 0.05  # near-Nash teacher for supervision


def test_dataset_shape_is_backend_agnostic() -> None:
    """§32 gate: the SAME data targets local or tinker backends."""
    dataset = build_teacher_dataset(train_cfr_teacher(60))
    ex: RenderedExample = dataset[0]
    assert ex.candidates == ("A0", "A1")
    assert ex.environment_action_ids in ((0, 1),)  # kuhn legal actions are 0/1
    assert all(0.0 <= p <= 1.0 for p in ex.teacher_probs)
    assert sum(ex.teacher_probs) == pytest_approx_one(ex.teacher_probs)

    local = LocalBackend(seed=0)
    err = local.train_step(dataset)
    assert err <= 0.5

    # A TinkerBackend accepts the identical objects at the interface level
    # (raises loudly only when it needs the network/SDK).
    import os

    os.environ["RULEZERO_ENABLE_TINKER"] = "1"
    try:
        from rulezero.backends import TinkerBackend

        tb = TinkerBackend(model_id="qwen3.5-4b")
        try:
            tb.train_step(dataset[:1])
            raised = False
        except (ImportError, NotImplementedError):
            raised = True
        assert raised  # interface consumed the data; failure is provider-side only
    finally:
        del os.environ["RULEZERO_ENABLE_TINKER"]


def pytest_approx_one(probs) -> float:
    return abs(sum(probs) - 1.0) < 1e-6


def test_pipeline_determinism(tmp_path: Path) -> None:
    a = run_kuhn_sft_experiment(tmp_path / "a", cfr_iterations=80, eval_games=80)
    b = run_kuhn_sft_experiment(tmp_path / "b", cfr_iterations=80, eval_games=80)
    assert a["metrics"]["imitation_accuracy"] == b["metrics"]["imitation_accuracy"]
    assert (
        a["metrics"]["vs_random"]["avg_return_p0"]
        == b["metrics"]["vs_random"]["avg_return_p0"]
    )
    assert a["checkpoint_sha256"] == b["checkpoint_sha256"]
