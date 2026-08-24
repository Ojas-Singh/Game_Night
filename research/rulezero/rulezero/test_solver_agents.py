"""Phase 3A §9-§11 gates: CPU solver agents, cache, capability selection."""
from __future__ import annotations

import pytest

from rulezero.gallery import get_spec
from rulezero.lab import simulate
from rulezero.solver_agents import (
    CFRAgent,
    PolicyCache,
    _remember_legals,
    choose_agent_for_game,
    solve_game_cfr,
)


def test_cfr_solves_kuhnish_with_real_nash_conv() -> None:
    sol = solve_game_cfr(get_spec("kuhnish"), iterations=300, use_cache=False)
    assert sol["nashConv"] is not None and sol["nashConv"] < 0.05
    assert sol["states"] > 0 and not sol["cached"]
    # every row is a distribution over its own legal set
    for row in sol["policy"].values():
        assert abs(sum(row.values()) - 1.0) < 1e-6


def test_policy_cache_round_trip(tmp_path) -> None:
    cache = PolicyCache(root=tmp_path)
    h = "deadbeef" * 8
    assert cache.load(h, "cfr", 50) is None
    digest = cache.store(h, "cfr", 50,
                         {"ks": {3: 0.75, 4: 0.25}}, {"nashConv": 0.01})
    assert len(digest) == 16
    hit = cache.load(h, "cfr", 50)
    assert hit is not None
    pol, meta = hit
    assert pol == {"ks": {3: 0.75, 4: 0.25}}
    assert meta == {"nashConv": 0.01}


def test_solve_uses_cache(tmp_path) -> None:
    import rulezero.solver_agents as sa

    old = sa._CACHE
    sa._CACHE = PolicyCache(root=tmp_path)
    try:
        spec = get_spec("mini-bluff")
        first = sa.solve_game_cfr(spec, 100)
        assert not first["cached"]
        second = sa.solve_game_cfr(spec, 100)
        assert second["cached"] and second["solveSeconds"] == 0.0
        assert second["policy"] == first["policy"]
    finally:
        sa._CACHE = old


def test_cfr_agent_beats_random_in_lab() -> None:
    r = simulate(get_spec("kuhnish"),
                 [{"agent": "cfr"}, {"agent": "random"}],
                 episodes=200, seed=13)
    assert r["wins"]["p0"] > 60.0
    assert r["avgReturns"]["p0"] > 0.2


def test_strategy_probs_are_inspector_safe() -> None:
    """§13: distribution comes from the info-state key alone."""
    agent = CFRAgent(get_spec("kuhnish"), iterations=200)
    some_key = next(iter(agent.policy))
    legal, probs = agent.probs_for(some_key)
    assert len(legal) == len(probs) >= 1
    assert abs(sum(probs) - 1.0) < 1e-6
    # unseen info state -> empty (never leaks, never guesses hidden cards)
    assert agent.probs_for("totally unknown state") == ([], [])


def test_choose_agent_is_capability_aware() -> None:
    assert choose_agent_for_game(get_spec("kuhnish")) == "cfr"
    assert choose_agent_for_game(get_spec("mini-bluff")) == "cfr"
    big = get_spec("goofseq")
    assert choose_agent_for_game(big) == "cfr"  # 3-branch decisions
    many = {"schemaVersion": 1, "name": "x",
            "players": {"count": 2}, "entities": {},
            "zones": [], "vars": [],
            "phases": [{"id": "d", "kind": "decision",
                        "decision": {"actor": 0, "actions": [
                            {"id": f"a{i}"} for i in range(12)]}},
                       {"id": "end", "kind": "terminal"}]}
    assert choose_agent_for_game(many) == "random"


def test_legals_walk_matches_info_states() -> None:
    legals = _remember_legals(get_spec("kuhnish"))
    assert any(len(v) == 2 for v in legals.values())
    agent = CFRAgent(get_spec("kuhnish"), iterations=100)
    mapped = sum(1 for k in agent.policy if k in legals)
    assert mapped >= len(agent.policy) * 0.99


def test_service_lab_ops_end_to_end() -> None:
    from rulezero import service

    sess = None
    _, res = service.handle(sess, {"op": "labSolve",
                                   "spec": get_spec("claim"),
                                   "iterations": 100})
    assert res["ok"] and res["recommended"] == "cfr"
    assert res["nashConv"] is not None

    # strategy op on a real info state
    agent = CFRAgent(get_spec("claim"), iterations=100)
    key = next(iter(agent.policy))
    _, res2 = service.handle(None, {"op": "labStrategy",
                                    "spec": get_spec("claim"),
                                    "infoState": key, "iterations": 100})
    assert res2["ok"]
    assert abs(sum(res2["probs"]) - 1.0) < 1e-6
