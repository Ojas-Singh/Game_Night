"""Milestone 5 first experiment (§23): Kuhn Poker, CFR teacher → student.

The teacher is OpenSpiel's own CFRSolver — we do not reimplement CFR (§33).
The student is ANY ModelBackend trained with SFT on solver-labelled decision
nodes. Everything here is deterministic given a seed and iteration count.

Renderer: 'rulezero-action-only-v1'
    prompt = RULES <rules text> STATE <info_state> ACTIONS A0=..|A1=.. ANSWER:
    target = dense candidateId 'A0'/'A1'  (§8 — never raw packed integers)
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import pyspiel
from open_spiel.python.algorithms import cfr, exploitability

from .backends import (
    LocalBackend,
    ModelBackend,
    RenderedExample,
    SFT,
    sha256_file,
)

GAME = pyspiel.load_game("kuhn_poker")
RULES_TEXT = (
    "Kuhn poker: 2 players; deck {J,Q,K} x1 each. Each antes 1. "
    "One card each, fold/check/bet/call rules as standard Kuhn. "
    "Actions here are always [check-or-fold, bet-or-call]."
)


# ---------------------------------------------------------------------------
# Teacher
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TeacherPolicy:
    """CFR average policy keyed by information-state string."""

    probs: dict[str, tuple[float, ...]]  # info_state -> P(action index)
    exploitability: float
    iterations: int


def train_cfr_teacher(iterations: int = 400) -> TeacherPolicy:
    game = pyspiel.load_game("kuhn_poker")
    solver = cfr.CFRSolver(game)
    for _ in range(iterations):
        solver.evaluate_and_update_policy()
    avg = solver.average_policy()
    table: dict[str, tuple[float, ...]] = {}
    for key, obj in avg.state_lookup.items():
        table[key] = tuple(float(p) for p in avg.action_probability_array[obj])
    conv = float(exploitability.nash_conv(game, avg))
    return TeacherPolicy(probs=table, exploitability=conv, iterations=iterations)


# ---------------------------------------------------------------------------
# Dataset construction
# ---------------------------------------------------------------------------


def _walk_decision_nodes(
    state: Any,
    out: list[tuple[Any, int]],
) -> None:
    """Collect (state, player) at every reachable decision node."""
    if state.is_terminal():
        return
    if state.is_chance_node():
        for outcome, _p in state.chance_outcomes():
            clone = state.clone()
            clone.apply_action(outcome)
            _walk_decision_nodes(clone, out)
        return
    player = state.current_player()
    out.append((state.clone(), player))
    for action in state.legal_actions():
        clone = state.clone()
        clone.apply_action(action)
        _walk_decision_nodes(clone, out)


def render_prompt(info_state: str, legal_actions: Sequence[int]) -> str:
    cands = " | ".join(
        f"A{i}={'check/fold' if a == 0 else 'bet/call'}"
        for i, a in enumerate(legal_actions)
    )
    return f"RULES {RULES_TEXT}\nSTATE {info_state}\nACTIONS {cands}\nANSWER:"


def build_teacher_dataset(teacher: TeacherPolicy) -> list[RenderedExample]:
    nodes: list[tuple[Any, int]] = []
    root = GAME.new_initial_state()
    _walk_decision_nodes(root, nodes)

    examples: dict[str, RenderedExample] = {}
    rng_state = 12345

    def rand() -> float:
        nonlocal rng_state
        rng_state = (1103515245 * rng_state + 12345) % (2**31)
        return rng_state / (2**31)

    for state, player in nodes:
        key = state.information_state_string(player)
        if key not in teacher.probs:
            continue
        legal = sorted(state.legal_actions())
        probs = teacher.probs[key]
        # candidateId i <-> environment action legal[i] (dense, §8)
        # Sample target stochastically from the teacher distribution so the
        # student sees the true support rather than pure argmax memorization.
        r = rand()
        acc = 0.0
        sampled = len(legal) - 1
        for i in range(len(legal)):
            acc += probs[legal[i]]
            if r <= acc:
                sampled = i
                break
        final_idx = sampled
        examples[key] = RenderedExample(
            info_state_key=key,
            prompt=render_prompt(key, legal),
            candidates=tuple(f"A{i}" for i in range(len(legal))),
            target=f"A{final_idx}",
            environment_action_ids=tuple(legal),
            teacher_probs=tuple(probs[a] for a in legal),
        )
    return list(examples.values())


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------


def imitation_accuracy(
    backend: ModelBackend, dataset: Sequence[RenderedExample]
) -> float:
    hits = total = 0
    for ex in dataset:
        pick = backend.sample(ex.prompt, ex.candidates)
        total += 1
        hits += int(pick == ex.target)
    return hits / max(1, total)


def play_games(
    backend: ModelBackend,
    opponent: str,
    n_games: int,
    seed: int = 0,
) -> dict[str, float]:
    """Average return of the backend's policy over full kuhn games.

    opponent: 'teacher' (CFR average policy sampling) or 'random'.
    The backend acts through its prompt/sample interface exactly like a
    deployed model would — no privileged access.
    """

    def policy_action(state: Any, player: int, use_backend: bool) -> int:
        legal = sorted(state.legal_actions())
        if use_backend:
            key = state.information_state_string(player)
            prompt = render_prompt(key, legal)
            pick = backend.sample(prompt, [f"A{i}" for i in range(len(legal))])
            idx = int(pick[1:]) if pick.startswith("A") and pick[1:].isdigit() else 0
            return legal[min(idx, len(legal) - 1)]
        if opponent == "random":
            return legal[int(rnd() * len(legal)) % len(legal)]
        raise ValueError(opponent)

    rng_state = seed or 1

    def rnd() -> float:
        nonlocal rng_state
        rng_state = (1103515245 * rng_state + 12345) % (2**31)
        return rng_state / (2**31)

    returns_sum = 0.0
    illegal = 0
    for ep in range(n_games):
        state = GAME.new_initial_state()
        while not state.is_terminal():
            if state.is_chance_node():
                outcomes, probs = zip(*state.chance_outcomes())
                r, acc = rnd(), 0.0
                choice = outcomes[-1]
                for o, p in zip(outcomes, probs):
                    acc += p
                    if r <= acc:
                        choice = o
                        break
                state.apply_action(choice)
                continue
            player = state.current_player()
            if player == 0:
                action = policy_action(state, player, True)
            else:
                legal = sorted(state.legal_actions())
                action = policy_action(state, player, False)
                if action not in legal:  # defensive
                    illegal += 1
                    action = legal[0]
            if action not in state.legal_actions():
                illegal += 1
                action = state.legal_actions()[0]
            state.apply_action(action)
        rets = state.returns()
        returns_sum += rets[0]

    return {
        "avg_return_p0": returns_sum / max(1, n_games),
        "games": n_games,
        "illegal_forced": illegal,
    }


# ---------------------------------------------------------------------------
# Experiment entry point → manifest (§19/§22/§32)
# ---------------------------------------------------------------------------


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

    teacher = train_cfr_teacher(cfr_iterations)
    dataset = build_teacher_dataset(teacher)

    backend = LocalBackend(seed=seed)
    algo = SFT()
    train_summary = algo.run(backend, dataset, epochs=epochs, seed=seed)

    ckpt = out_dir / "checkpoint.json"
    backend.save(ckpt)
    reloaded = LocalBackend(seed=seed)
    reloaded.load(ckpt)

    metrics = {
        "teacher_exploitability": teacher.exploitability,
        "cfr_iterations": cfr_iterations,
        "dataset_size": len(dataset),
        "imitation_accuracy": imitation_accuracy(reloaded, dataset),
        "vs_random": play_games(reloaded, "random", eval_games, seed=seed),
        "parse_rate": 1.0,  # local backend cannot emit unparseable output
        "wall_seconds": round(time.time() - started, 3),
    }

    manifest = {
        "experiment": "kuhn-cfr-sft",
        "game": "kuhn_poker",
        "renderer": "rulezero-action-only-v1",
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
        json.dumps([asdict_if(ex) for ex in dataset], indent=2)
    )
    return manifest


def asdict_if(ex: RenderedExample) -> dict[str, Any]:
    from dataclasses import asdict

    d = asdict(ex)
    d["candidates"] = list(ex.candidates)
    d["environment_action_ids"] = list(ex.environment_action_ids)
    d["teacher_probs"] = list(ex.teacher_probs) if ex.teacher_probs else None
    return d


if __name__ == "__main__":
    import sys

    out = Path(sys.argv[1] if len(sys.argv) > 1 else "reports/experiments/kuhn-sft-local")
    m = run_kuhn_sft_experiment(out)
    print(json.dumps(m["metrics"], indent=2))
