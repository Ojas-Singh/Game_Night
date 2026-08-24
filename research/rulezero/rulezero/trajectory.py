"""Trajectory recorder (§29 schema doc made concrete): one JSONL episode per
line, exactly the TRAJECTORY_SCHEMA.md v1 contract — dense candidate ids +
environmentActionIds per decision, seed schedule for exact replay, bounded
returns plus raw scores, nullable policy/value/belief fields for §29.
"""
from __future__ import annotations

import time
from typing import Any

from .artifacts import ArtifactStore
from .game_definition import canonical_json


def _lcg(seed: int):
    state = seed or 1

    def rnd() -> float:
        nonlocal state
        state = (1103515245 * state + 12345) % (2**31)
        return state / (2**31)

    return rnd


def record_episode(
    game: Any,
    policies: dict[int, Any],
    seed_schedule: list[int],
    game_id: str = "unknown",
    spec_hash: str | None = None,
    num_players: int | None = None,
) -> dict[str, Any]:
    """Play ONE episode; `policies[p]` is called as
    policy(info_state, candidates) -> candidateIndex for each seat p.

    candidates are dense A0..An with environmentActionIds recorded (§8).
    """
    rnd = _lcg(seed_schedule[0] if seed_schedule else 1)
    transitions: list[dict[str, Any]] = []
    seeds_used: list[int] = []
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
            seeds_used.append(int(choice))
            transitions.append({
                "t": len(transitions),
                "player": -1,
                "kind": "chance",
                "infoState": None,
                "observation": None,
                "legalEnvironmentActions": [int(o) for o in outcomes],
                "candidates": [
                    {"candidateId": f"C{i}", "environmentActionId": int(o), "label": f"chance{o}"}
                    for i, o in enumerate(outcomes)
                ],
                "chosenCandidateId": f"C{outcomes.index(choice)}",
                "chosenEnvironmentActionId": int(choice),
                "policy": None, "teacherPolicy": None,
                "valueTarget": None, "beliefTarget": None,
            })
            state.apply_action(choice)
            continue

        player = state.current_player()
        legal = sorted(state.legal_actions(player))
        info = state.information_state_string(player)
        cands = [
            {"candidateId": f"A{i}", "environmentActionId": a, "label": f"action{a}"}
            for i, a in enumerate(legal)
        ]
        pick_idx = int(policies[player](info, cands))
        if not (0 <= pick_idx < len(legal)):
            parse_failures = True
            pick_idx = 0
        else:
            parse_failures = False
        action = legal[pick_idx]
        transitions.append({
            "t": len(transitions),
            "player": player,
            "kind": "decision",
            "infoState": info,
            "observation": None,
            "legalEnvironmentActions": legal,
            "candidates": cands,
            "chosenCandidateId": f"A{pick_idx}",
            "chosenEnvironmentActionId": action,
            "policy": None, "teacherPolicy": None,
            "valueTarget": None, "beliefTarget": None,
        })
        if parse_failures:
            raise ValueError("policy returned an out-of-range candidate")
        state.apply_action(action)

    n = num_players if num_players is not None else game.num_players()
    rets = list(state.returns()) if state.is_terminal() else [0.0] * n
    return {
        "schemaVersion": 1,
        "trajectoryId": f"traj-{time.time_ns()}",
        "game": {
            "id": game_id,
            "specHash": spec_hash,
            "numPlayers": n,
            "parameters": {},
        },
        "provenance": {
            "producingCommit": "recorded-at-runtime",
            "runner": "rulezero.trajectory@v1",
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
        "seedSchedule": seeds_used,
        "returns": rets,
        "finalScores": {},
        "transitions": transitions,
    }


def episodes_to_jsonl(episodes: list[dict[str, Any]]) -> bytes:
    return "\n".join(canonical_json(e) for e in episodes).encode()


def store_episodes(
    store: ArtifactStore,
    episodes: list[dict[str, Any]],
    config_hash: str = "",
    parents: list[str] | None = None,
) -> str:
    """Bulk trajectories → artifact store (never Git, §19)."""
    return store.put(
        episodes_to_jsonl(episodes),
        kind="trajectories",
        config_hash=config_hash,
        parents=parents,
        meta={"episodes": len(episodes)},
    )
