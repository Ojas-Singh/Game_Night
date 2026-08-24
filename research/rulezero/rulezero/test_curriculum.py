"""M6 seam gates: multi-game curriculum on ONE shared model (§26/§27)."""
from __future__ import annotations

from pathlib import Path

import pytest  # noqa: F401

from rulezero.backends import LocalBackend
from rulezero.curriculum import (
    KUHN,
    LEDUC,
    GameTask,
    build_teacher_dataset,
    imitation_accuracy,
    play_games,
    run_curriculum_experiment,
    train_cfr_teacher,
)

REQUIRED = {
    "experiment",
    "tasks",
    "renderer",
    "shared_model",
    "backend",
    "training_algorithm",
    "seed",
    "checkpoint_sha256",
    "open_spiel_version",
    "metrics",
}


def test_leduc_task_shapes() -> None:
    teacher = train_cfr_teacher(LEDUC, iterations=40)
    ds = build_teacher_dataset(LEDUC, teacher)
    assert len(ds) > 300  # leduc is genuinely larger than kuhn's 12
    ex = ds[0]
    # candidates always mirror the legal-action set of their own node
    assert ex.candidates == tuple(f"A{i}" for i in range(len(ex.environment_action_ids)))
    assert abs(sum(ex.teacher_probs) - 1.0) < 1e-9
    assert ex.info_state_key.startswith("leduc_poker:")
    assert "Leduc" in ex.prompt and "Kuhn" not in ex.prompt
    # and the full action vocabulary {fold,call/check,raise} appears dataset-wide
    seen_actions = set()
    for e in ds:
        seen_actions.update(e.environment_action_ids)
        if len(e.candidates) == 3:
            assert e.candidates == ("A0", "A1", "A2")
            break
    else:
        raise AssertionError("no 3-candidate leduc decision found")
    assert seen_actions == {0, 1, 2}


def test_shared_model_no_cross_game_interference(tmp_path: Path) -> None:
    """One tabular model trained on the union must match per-game training."""
    t_k = train_cfr_teacher(KUHN, iterations=60)
    t_l = train_cfr_teacher(LEDUC, iterations=40)
    ds_k = build_teacher_dataset(KUHN, t_k)
    ds_l = build_teacher_dataset(LEDUC, t_l)

    joint = LocalBackend(seed=0)
    joint.train_step(ds_k + ds_l)

    solo_k = LocalBackend(seed=0)
    solo_k.train_step(ds_k)
    solo_l = LocalBackend(seed=0)
    solo_l.train_step(ds_l)

    assert imitation_accuracy(joint, ds_k) == imitation_accuracy(solo_k, ds_k)
    assert imitation_accuracy(joint, ds_l) == imitation_accuracy(solo_l, ds_l)


def test_full_curriculum_run_and_manifest(tmp_path: Path) -> None:
    manifest = run_curriculum_experiment(
        [KUHN, LEDUC], tmp_path, cfr_iterations=50, eval_games=100, epochs=2
    )
    assert not REQUIRED - set(manifest)
    m = manifest["metrics"]
    assert manifest["tasks"] == ["kuhn_poker", "leduc_poker"]
    assert manifest["shared_model"] is True
    assert m["union_size"] == sum(m["dataset_sizes"].values())
    for gid in ("kuhn_poker", "leduc_poker"):
        assert m[f"{gid}/imitation_accuracy"] >= 0.95
        assert m[f"{gid}/vs_random"]["illegal_forced"] == 0
    assert (tmp_path / "manifest.json").exists()
    assert (tmp_path / "dataset.json").exists()


def test_curriculum_determinism(tmp_path: Path) -> None:
    a = run_curriculum_experiment(
        [KUHN, LEDUC], tmp_path / "a", cfr_iterations=30, eval_games=60
    )
    b = run_curriculum_experiment(
        [KUHN, LEDUC], tmp_path / "b", cfr_iterations=30, eval_games=60
    )
    ma, mb = a["metrics"], b["metrics"]
    assert ma["union_size"] == mb["union_size"]
    assert (
        ma["leduc_poker/vs_random"]["avg_return_p0"]
        == mb["leduc_poker/vs_random"]["avg_return_p0"]
    )
    assert a["checkpoint_sha256"] == b["checkpoint_sha256"]


def test_backend_player_one_evaluation_supported(tmp_path: Path) -> None:
    """The harness must evaluate from EITHER seat (fairness, §28)."""
    teacher = train_cfr_teacher(KUHN, iterations=60)
    ds = build_teacher_dataset(KUHN, teacher)
    backend = LocalBackend(seed=0)
    backend.train_step(ds)
    r = play_games(KUHN, backend, "random", 80, seed=3, backend_player=1)
    assert r["games"] == 80
    assert "avg_return_p1" in r


def test_task_registry_is_data_only() -> None:
    """§10: tasks are pure data — game id + rules text + action labels."""
    for task in (KUHN, LEDUC):
        assert isinstance(task, GameTask)
        assert callable(task.load)
        assert all(isinstance(k, int) for k in task.action_labels)
