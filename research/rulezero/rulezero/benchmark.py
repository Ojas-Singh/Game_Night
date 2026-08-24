"""Zero-shot benchmark over held-out GameSpec families (M6/§27/§35).

Measures a backend on games whose FAMILY never appeared in training.
The harness enforces the §27 rule mechanically: it refuses to score a
definition whose family_id is in the seen-families set — "unseen" is
checked, not asserted.

All play goes through the SAME public interface used by real deployments:
rules text + information state + dense candidates in, candidateId out
(§28 fairness conditions). No privileged state access anywhere.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Sequence

from .backends import ModelBackend, sha256_file
from .game_definition import GameDefinition, canonical_json
from .gamespec_ir import IRValidationError, ir_hash, load_ir

RENDERER = "rulezero-action-only-v1"


def render_spec_prompt(defn: GameDefinition, info_state: str, n_candidates: int) -> str:
    cands = " | ".join(f"A{i}=action{i}" for i in range(n_candidates))
    return (
        f"RULES {defn.rules_text}\n"
        f"STATE {info_state}\n"
        f"ACTIONS {cands}\nANSWER:"
    )


class UnseenFamilyError(ValueError):
    pass


def enforce_unseen(defs: Sequence[GameDefinition], seen_families: set[str]) -> None:
    """§27: refuse to call anything 'zero-shot' if its family was trained on."""
    for d in defs:
        if d.family_id in seen_families:
            raise UnseenFamilyError(
                f"{d.family_id} is in the training families — "
                "it cannot appear in a zero-shot benchmark"
            )


def play_spec_games(
    defn: GameDefinition,
    backend: ModelBackend,
    n_episodes: int,
    seed: int = 0,
    backend_player: int = 0,
) -> dict[str, float]:
    """Play `n_episodes` of a GameSpec game; backend acts via prompts only.

    Opponent is uniform-random over legal candidates. Chance outcomes are
    sampled with the same deterministic LCG schedule as every other runner.
    """
    # Import here (not module level) to keep backends importable standalone.
    from .gamespec_runtime import IRGame

    doc = load_ir(dict(defn.spec))
    if ir_hash(doc) != hashlib_of(defn):
        raise ValueError("GameDefinition spec does not match its recorded hash")
    game = IRGame(doc)

    rng = seed or 1

    def rnd() -> float:
        nonlocal rng
        rng = (1103515245 * rng + 12345) % (2**31)
        return rng / (2**31)

    ret_sum = 0.0
    illegal_forced = 0
    parse_failures = 0
    decisions = 0
    for _ep in range(n_episodes):
        state = game.new_initial_state()
        steps = 0
        while not state.is_terminal() and steps < 10_000:
            steps += 1
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
            legal = list(state.legal_actions(player))
            if player == backend_player:
                info = state.information_state_string(player)
                prompt = render_spec_prompt(defn, info, len(legal))
                pick = backend.sample(prompt, [f"A{i}" for i in range(len(legal))])
                decisions += 1
                idx = -1
                if pick.startswith("A") and pick[1:].isdigit():
                    idx = int(pick[1:])
                if not (0 <= idx < len(legal)):
                    parse_failures += 1
                    idx = 0
                action = legal[min(idx, len(legal) - 1)]
            else:
                action = legal[int(rnd() * len(legal)) % len(legal)]
            if action not in legal:
                illegal_forced += 1
                action = legal[0]
            state.apply_action(action)
        ret_sum += state.returns()[backend_player]

    return {
        f"avg_return_p{backend_player}": ret_sum / max(1, n_episodes),
        "games": n_episodes,
        "decisions": decisions,
        "parse_failures": parse_failures,
        "illegal_forced": illegal_forced,
    }


def hashlib_of(defn: GameDefinition) -> str:
    import hashlib as _h

    return _h.sha256(canonical_json(defn.spec).encode()).hexdigest()


# ---------------------------------------------------------------------------
# Benchmark entry point → manifest (§19)
# ---------------------------------------------------------------------------


def run_zero_shot_benchmark(
    backend: ModelBackend,
    defs: Sequence[GameDefinition],
    seen_families: set[str],
    out_dir: Path | None = None,
    episodes_per_game: int = 200,
    seed: int = 0,
) -> dict[str, Any]:
    started = time.time()
    enforce_unseen(defs, seen_families)

    results: dict[str, Any] = {}
    for d in defs:
        results[d.family_id] = {
            "spec_hash": d.spec_hash,
            **play_spec_games(d, backend, episodes_per_game, seed=seed),
        }

    manifest = {
        "benchmark": "rulezero-zero-shot-gamespec",
        "renderer": RENDERER,
        "backend": {
            "kind": backend.metadata().backend_kind,
            "model_id": backend.metadata().model_id,
            "renderer": backend.metadata().renderer,
        },
        "seen_families": sorted(seen_families),
        "held_out_families": [d.family_id for d in defs],
        "episodes_per_game": episodes_per_game,
        "seed": seed,
        "results": results,
        "wall_seconds": round(time.time() - started, 3),
    }
    if out_dir is not None:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


if __name__ == "__main__":
    import sys

    from .backends import LocalBackend

    m = run_zero_shot_benchmark(LocalBackend(seed=0), [], set(), episodes_per_game=0)
    print(json.dumps(m, indent=2))
