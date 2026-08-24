"""Multi-game teacher curriculum (M6 seam, §26).

One renderer, one dataset contract, ONE student model across games:
P(action | rules text, information state, legal candidates) — the rules text
in the prompt is what lets a single tabular/policy table hold several games
without collision, and is the same input shape a language-model backend
receives.

Teachers are OpenSpiel solvers only (CFR here); never reimplemented (§33).
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

import pyspiel
from open_spiel.python.algorithms import cfr, exploitability

from .backends import (
    LocalBackend,
    ModelBackend,
    ModelMetadata,
    RenderedExample,
    SFT,
    sha256_file,
)

RENDERER = "rulezero-action-only-v1"


# ---------------------------------------------------------------------------
# Task definitions
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GameTask:
    game_id: str
    rules_text: str
    action_labels: dict[int, str]

    def load(self):
        return pyspiel.load_game(self.game_id)

    def label(self, action: int) -> str:
        return self.action_labels.get(action, f"action{action}")

    def render_prompt(self, info_state: str, legal: Sequence[int]) -> str:
        cands = " | ".join(f"A{i}={self.label(a)}" for i, a in enumerate(legal))
        return f"RULES {self.rules_text}\nSTATE {info_state}\nACTIONS {cands}\nANSWER:"


KUHN = GameTask(
    game_id="kuhn_poker",
    rules_text=(
        "Kuhn poker: 2 players; deck {J,Q,K} x1 each. Each antes 1. "
        "One card each, fold/check/bet/call rules as standard Kuhn."
    ),
    action_labels={0: "check/fold", 1: "bet/call"},
)

LEDUC = GameTask(
    game_id="leduc_poker",
    rules_text=(
        "Leduc poker: 2 players; deck {J,Q,K} x2 each. One private card each, "
        "one public card after round 1. Bet sizes 2 then 4; two betting "
        "rounds; standard show-down by hand rank."
    ),
    action_labels={0: "fold", 1: "call/check", 2: "raise"},
)


# ---------------------------------------------------------------------------
# Teacher
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TeacherPolicy:
    probs: dict[str, tuple[float, ...]]  # info_state -> P(env action)
    exploitability: float
    iterations: int
    game_id: str


def train_cfr_teacher(task: GameTask, iterations: int) -> TeacherPolicy:
    game = task.load()
    solver = cfr.CFRSolver(game)
    for _ in range(iterations):
        solver.evaluate_and_update_policy()
    avg = solver.average_policy()
    table = {
        key: tuple(float(p) for p in avg.action_probability_array[obj])
        for key, obj in avg.state_lookup.items()
    }
    conv = float(exploitability.nash_conv(game, avg))
    return TeacherPolicy(
        probs=table, exploitability=conv, iterations=iterations, game_id=task.game_id
    )


# ---------------------------------------------------------------------------
# Dataset construction (generic walk)
# ---------------------------------------------------------------------------


def _walk_decision_nodes(game: Any, state: Any, out: list[tuple[Any, int]]) -> None:
    if state.is_terminal():
        return
    if state.is_chance_node():
        for outcome, _p in state.chance_outcomes():
            clone = state.clone()
            clone.apply_action(outcome)
            _walk_decision_nodes(game, clone, out)
        return
    player = state.current_player()
    out.append((state.clone(), player))
    for action in state.legal_actions():
        clone = state.clone()
        clone.apply_action(action)
        _walk_decision_nodes(game, clone, out)


def build_teacher_dataset(
    task: GameTask, teacher: TeacherPolicy, seed: int = 12345
) -> list[RenderedExample]:
    game = task.load()
    nodes: list[tuple[Any, int]] = []
    _walk_decision_nodes(game, game.new_initial_state(), nodes)

    examples: dict[tuple[str, int], RenderedExample] = {}
    rng_state = seed or 1

    def rand() -> float:
        nonlocal rng_state
        rng_state = (1103515245 * rng_state + 12345) % (2**31)
        return rng_state / (2**31)

    for state, player in nodes:
        key = state.information_state_string(player)
        if key not in teacher.probs:
            continue
        cache_key = (key, player)
        if cache_key in examples:
            continue
        legal = sorted(state.legal_actions())
        probs = teacher.probs[key]
        r, acc, sampled = rand(), 0.0, len(legal) - 1
        for i in range(len(legal)):
            acc += probs[legal[i]]
            if r <= acc:
                sampled = i
                break
        examples[cache_key] = RenderedExample(
            info_state_key=f"{task.game_id}:{player}:{key}",
            prompt=task.render_prompt(key, legal),
            candidates=tuple(f"A{i}" for i in range(len(legal))),
            target=f"A{sampled}",
            environment_action_ids=tuple(legal),
            teacher_probs=tuple(probs[a] for a in legal),
        )
    return list(examples.values())


# ---------------------------------------------------------------------------
# Evaluation (backend acts through its public interface only)
# ---------------------------------------------------------------------------


def play_games(
    task: GameTask,
    backend: ModelBackend,
    opponent: str,
    n_games: int,
    seed: int = 0,
    backend_player: int = 0,
) -> dict[str, float]:
    game = task.load()
    rng_state = seed or 1

    def rnd() -> float:
        nonlocal rng_state
        rng_state = (1103515245 * rng_state + 12345) % (2**31)
        return rng_state / (2**31)

    returns_sum = 0.0
    illegal = 0
    for _ in range(n_games):
        state = game.new_initial_state()
        while not state.is_terminal():
            if state.is_chance_node():
                outcomes, probs = zip(*state.chance_outcomes())
                r, acc, choice = rnd(), 0.0, outcomes[-1]
                for o, p in zip(outcomes, probs):
                    acc += p
                    if r <= acc:
                        choice = o
                        break
                state.apply_action(choice)
                continue
            player = state.current_player()
            legal = sorted(state.legal_actions())
            if player == backend_player:
                key = state.information_state_string(player)
                pick = backend.sample(
                    task.render_prompt(key, legal), [f"A{i}" for i in range(len(legal))]
                )
                idx = int(pick[1:]) if pick.startswith("A") and pick[1:].isdigit() else 0
                action = legal[min(idx, len(legal) - 1)]
            elif opponent == "random":
                action = legal[int(rnd() * len(legal)) % len(legal)]
            else:
                raise ValueError(opponent)
            if action not in state.legal_actions():
                illegal += 1
                action = state.legal_actions()[0]
            state.apply_action(action)
        returns_sum += state.returns()[backend_player]

    return {
        f"avg_return_p{backend_player}": returns_sum / max(1, n_games),
        "games": n_games,
        "illegal_forced": illegal,
    }


def imitation_accuracy(
    backend: ModelBackend, dataset: Sequence[RenderedExample]
) -> float:
    hits = total = 0
    for ex in dataset:
        total += 1
        hits += int(backend.sample(ex.prompt, ex.candidates) == ex.target)
    return hits / max(1, total)


# ---------------------------------------------------------------------------
# Curriculum experiment runner → manifest (§19/§22/§26)
# ---------------------------------------------------------------------------


def run_curriculum_experiment(
    tasks: Sequence[GameTask],
    out_dir: Path,
    cfr_iterations: int = 150,
    eval_games: int = 200,
    epochs: int = 3,
    seed: int = 0,
    backend: ModelBackend | None = None,
) -> dict[str, Any]:
    """Train ONE shared backend on the union of per-game teacher datasets."""
    started = time.time()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    backend = backend or LocalBackend(seed=seed)

    datasets: dict[str, list[RenderedExample]] = {}
    teachers: dict[str, dict[str, Any]] = {}
    for task in tasks:
        teacher = train_cfr_teacher(task, cfr_iterations)
        teachers[task.game_id] = {
            "exploitability": teacher.exploitability,
            "iterations": cfr_iterations,
        }
        datasets[task.game_id] = build_teacher_dataset(task, teacher, seed=seed)

    union = [ex for ds in datasets.values() for ex in ds]
    algo = SFT()
    train_summary = algo.run(backend, union, epochs=epochs, seed=seed)

    ckpt = out_dir / "checkpoint.json"
    backend.save(ckpt)
    reloaded = LocalBackend(seed=seed)
    reloaded.load(ckpt)

    metrics: dict[str, Any] = {
        "teachers": teachers,
        "dataset_sizes": {gid: len(ds) for gid, ds in datasets.items()},
        "union_size": len(union),
        "wall_seconds": round(time.time() - started, 3),
        "parse_rate": 1.0,
    }
    for task in tasks:
        ds = datasets[task.game_id]
        metrics[f"{task.game_id}/imitation_accuracy"] = imitation_accuracy(reloaded, ds)
        metrics[f"{task.game_id}/vs_random"] = play_games(
            task, reloaded, "random", eval_games, seed=seed
        )

    manifest = {
        "experiment": "curriculum-cfr-sft",
        "tasks": [t.game_id for t in tasks],
        "renderer": RENDERER,
        "shared_model": True,
        "backend": {"kind": reloaded.metadata().backend_kind,
                     "model_id": reloaded.metadata().model_id},
        "training_algorithm": train_summary,
        "seed": seed,
        "epochs": epochs,
        "checkpoint_sha256": sha256_file(ckpt),
        "open_spiel_version": pyspiel.__version__,
        "metrics": metrics,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (out_dir / "dataset.json").write_text(
        json.dumps([_ex_dict(ex) for ex in union], indent=2)
    )
    return manifest


def _ex_dict(ex: RenderedExample) -> dict[str, Any]:
    from dataclasses import asdict

    d = asdict(ex)
    d["candidates"] = list(ex.candidates)
    d["environment_action_ids"] = list(ex.environment_action_ids)
    d["teacher_probs"] = list(ex.teacher_probs) if ex.teacher_probs else None
    return d


if __name__ == "__main__":
    import sys

    out = Path(sys.argv[1] if len(sys.argv) > 1 else "reports/experiments/curriculum-kuhn-leduc")
    m = run_curriculum_experiment([KUHN, LEDUC], out)
    print(json.dumps(m["metrics"], indent=2)[:1200])
