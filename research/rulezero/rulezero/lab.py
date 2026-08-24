"""Simulation Lab (Phase 3A §12): server-side episode batches for any
GameSpec game, CPU agents only, deterministic under a seed.

Agents are capability-aware by name; the registry is where solver/search
agents plug in later (§9/§10) without changing this runner.
"""
from __future__ import annotations

import time
from typing import Any, Callable

from .gamespec_runtime import IRGame

AgentFn = Callable[[str, list[dict[str, Any]]], int]  # (infoState, candidates)->idx


def _cfr_agent_factory(seed: int = 0):
    """Deferred: built per-spec in simulate() because it needs the spec."""
    raise NotImplementedError("cfr agents are bound per-spec inside simulate()")

EPISODE_LIMIT = 20_000      # §33: hard caps for lab jobs
STEP_CAP = 5_000


def random_agent(seed: int = 0) -> AgentFn:
    state = seed or 1

    def act(_info: str, cands: list[dict[str, Any]]) -> int:
        nonlocal state
        state = (1103515245 * state + 12345) % (2**31)
        return state % len(cands)

    return act


def first_agent(_seed: int = 0) -> AgentFn:
    return lambda _info, cands: 0


AGENTS: dict[str, Callable[..., AgentFn]] = {
    "random": random_agent,
    "first": first_agent,
}


def agent_names() -> list[str]:
    return sorted(AGENTS)


def simulate(
    spec: dict[str, Any],
    agent_specs: list[dict[str, Any]],
    episodes: int,
    seed: int = 42,
) -> dict[str, Any]:
    """Run `episodes` of the game; agent_specs like
    [{"agent": "random", "seed": 7}, ...] indexed by seat.

    Returns §12 stats: per-seat win/tie %, avg returns, mean length,
    actions/game. Deterministic for identical inputs.
    """
    if not (0 < int(episodes) <= EPISODE_LIMIT):
        raise ValueError(f"episodes must be in 1..{EPISODE_LIMIT}")
    episodes = int(episodes)
    n_players = spec["players"]["count"]
    if len(agent_specs) != n_players:
        raise ValueError(f"need {n_players} agent specs")

    cfr_iters = int(spec.get("_cfrIterations", 300))

    def make(i: int) -> AgentFn:
        name = agent_specs[i].get("agent", "random")
        if name == "cfr":
            from .solver_agents import CFRAgent

            agent = CFRAgent(spec, iterations=cfr_iters)
            return lambda info, cands: _env_apply(agent, info, cands)
        if name not in AGENTS:
            raise ValueError(f"unknown agent {name!r}; available "
                             f"{agent_names() + ['cfr']}")
        return AGENTS[name](agent_specs[i].get("seed", seed + i))

    def _env_apply(agent, info: str, cands: list[dict[str, Any]]) -> int:
        idx = agent.act(info, [c["environmentActionId"] for c in cands])
        for j, c in enumerate(cands):
            if c["environmentActionId"] == idx:
                return j
        return 0

    fns = [make(i) for i in range(len(agent_specs))]

    started = time.time()
    game = IRGame(spec)
    wins = [0] * n_players
    ties = 0
    ret_sums = [0.0] * n_players
    total_steps = 0
    total_decisions = 0
    unfinished = 0

    for _ep in range(episodes):
        s = game.new_initial_state()
        steps = 0
        while not s.is_terminal():
            steps += 1
            if steps > STEP_CAP:
                unfinished += 1
                break
            if s.is_chance_node():
                outs = s.chance_outcomes()
                pick = _uniform(outs, (seed + 7919 * _ep) * 31 + steps)
                s.apply_action(pick)
                continue
            player = s.current_player()
            legal = sorted(s.legal_actions(player))
            info = s.information_state_string(player)
            cands = [
                {"candidateId": f"A{i}", "environmentActionId": a}
                for i, a in enumerate(legal)
            ]
            idx = fns[player](info, cands)
            if not (0 <= idx < len(legal)):
                idx = 0
            total_decisions += 1
            s.apply_action(legal[idx])
        else:
            total_steps += steps
            if s.is_terminal():
                rets = s.returns()
                best = max(rets)
                for p in range(n_players):
                    ret_sums[p] += rets[p]
                    if rets[p] == best and best != 0:
                        wins[p] += 1
                if all(r == 0 for r in rets) or len(set(rets)) == 1:
                    ties += 1

    denom = max(1, episodes - unfinished)
    return {
        "episodes": episodes,
        "unfinished": unfinished,
        "wins": {f"p{p}": round(wins[p] / denom * 100, 1) for p in range(n_players)},
        "tiesPct": round(ties / denom * 100, 1),
        "avgReturns": {f"p{p}": round(ret_sums[p] / denom, 3) for p in range(n_players)},
        "meanGameLength": round(total_steps / denom, 2),
        "decisionsPerGame": round(total_decisions / denom, 2),
        "wallSeconds": round(time.time() - started, 3),
        "agents": [a.get("agent") for a in agent_specs],
    }


def _uniform(outcomes: list[tuple[int, float]], seed: int) -> int:
    st = seed or 1
    st = (1103515245 * st + 12345) % (2**31)
    r = st / (2**31)
    acc = 0.0
    for o, p in outcomes:
        acc += p
        if r <= acc:
            return o
    return outcomes[-1][0]
