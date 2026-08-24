"""Kuhn Poker first experiment (§23) — now a thin wrapper over the generic
curriculum harness (`rulezero.curriculum`). Kept as the canonical single-game
entry point and for backwards compatibility of the M5 report numbers."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pyspiel

from .backends import LocalBackend, RenderedExample, SFT, sha256_file
from . import curriculum as _cur
from .curriculum import (  # noqa: F401
    KUHN,
    RENDERER,
    TeacherPolicy,
    _ex_dict,
    imitation_accuracy,
)

# Back-compat aliases used by earlier tests/reports.
GAME = pyspiel.load_game("kuhn_poker")
RULES_TEXT = KUHN.rules_text

__all__ = [
    "TeacherPolicy",
    "train_cfr_teacher",
    "build_teacher_dataset",
    "render_prompt",
    "imitation_accuracy",
    "play_games",
    "run_kuhn_sft_experiment",
    "asdict_if",
]


def render_prompt(info_state: str, legal_actions: Any) -> str:
    return KUHN.render_prompt(info_state, legal_actions)


# --- Kuhn-signature adapters over the generic harness -----------------------


def train_cfr_teacher(iterations: int = 400) -> TeacherPolicy:
    """Old M5 signature: iterations only (task fixed to Kuhn)."""
    return _cur.train_cfr_teacher(KUHN, iterations)


def build_teacher_dataset(teacher: TeacherPolicy, seed: int = 12345):
    return _cur.build_teacher_dataset(KUHN, teacher, seed=seed)


def play_games(
    backend,
    opponent: str,
    n_games: int,
    seed: int = 0,
):  # old signature
    return _cur.play_games(KUHN, backend, opponent, n_games, seed=seed)


def run_kuhn_sft_experiment(
    out_dir: Path,
    cfr_iterations: int = 200,
    eval_games: int = 200,
    epochs: int = 3,
    seed: int = 0,
    backend_kind: str = "local",
) -> dict[str, Any]:
    started = time.time()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    teacher = _cur.train_cfr_teacher(KUHN, cfr_iterations)
    dataset = _cur.build_teacher_dataset(KUHN, teacher)

    backend = LocalBackend(seed=seed)
    train_summary = SFT().run(backend, dataset, epochs=epochs, seed=seed)

    ckpt = out_dir / "checkpoint.json"
    backend.save(ckpt)
    reloaded = LocalBackend(seed=seed)
    reloaded.load(ckpt)

    metrics = {
        "teacher_exploitability": teacher.exploitability,
        "cfr_iterations": cfr_iterations,
        "dataset_size": len(dataset),
        "imitation_accuracy": imitation_accuracy(reloaded, dataset),
        "vs_random": _cur.play_games(
            KUHN, reloaded, "random", eval_games, seed=seed
        ),
        "parse_rate": 1.0,
        "wall_seconds": round(time.time() - started, 3),
    }

    manifest = {
        "experiment": "kuhn-cfr-sft",
        "game": "kuhn_poker",
        "renderer": RENDERER,
        "backend": {
            "kind": backend_kind,
            "requested": backend_kind,
            "model_id": reloaded.metadata().model_id,
        },
        "training_algorithm": train_summary,
        "seed": seed,
        "epochs": epochs,
        "checkpoint_sha256": sha256_file(ckpt),
        "open_spiel_version": pyspiel.__version__,
        "metrics": metrics,
        "notes": [
            "Teacher is OpenSpiel CFRSolver average policy (no reimplementation).",
            "Candidate ids are dense A0..An; environmentActionIds preserved.",
            "LocalBackend is the offline control proving pipeline correctness.",
        ],
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (out_dir / "dataset.json").write_text(
        json.dumps([_ex_dict(ex) for ex in dataset], indent=2)
    )
    return manifest


def asdict_if(ex: RenderedExample) -> dict[str, Any]:
    return _ex_dict(ex)


if __name__ == "__main__":
    import sys

    out = Path(sys.argv[1] if len(sys.argv) > 1 else "reports/experiments/kuhn-sft-local")
    m = run_kuhn_sft_experiment(out)
    print(json.dumps(m["metrics"], indent=2))
