"""Phase 3A §15/§16/§12 gates: gallery validity, variants, simulation lab."""
from __future__ import annotations

import pytest

from rulezero.gallery import GALLERY, catalog, get_spec
from rulezero.gamespec_ir import ir_hash
from rulezero.lab import EPISODE_LIMIT, agent_names, simulate


EXPECTED_GAMES = {
    "kuhnish", "mini-bluff", "hidden-duel", "goofseq",
    "secret-bid", "claim", "reveal-hold", "double-or-nothing",
}


def test_gallery_has_eight_mechanically_distinct_games() -> None:
    assert EXPECTED_GAMES <= set(GALLERY)
    hashes = {e["specHash"] for e in catalog()}
    assert len(hashes) == len(EXPECTED_GAMES)  # all distinct specs


def test_catalog_shape_is_ui_safe() -> None:
    for e in catalog():
        assert set(e) == {"id", "title", "blurb", "tags", "specHash", "mutations"}
        assert len(e["tags"]) >= 2 and e["blurb"]
        assert len(e["specHash"]) == 64


@pytest.mark.parametrize("gid", sorted(EXPECTED_GAMES))
def test_every_gallery_game_simulates_to_terminal(gid: str) -> None:
    r = simulate(get_spec(gid), [{"agent": "random"}, {"agent": "first"}],
                 episodes=40, seed=7)
    assert r["unfinished"] == 0, f"{gid} hit the step cap"
    assert r["meanGameLength"] > 0
    assert abs(sum(r["avgReturns"].values())) < 1e-6  # zero-sum


def test_simulation_is_deterministic() -> None:
    a = simulate(get_spec("mini-bluff"),
                 [{"agent": "random"}, {"agent": "random"}], 30, seed=9)
    b = simulate(get_spec("mini-bluff"),
                 [{"agent": "random"}, {"agent": "random"}], 30, seed=9)
    assert a == b


def test_unknown_agent_rejected() -> None:
    with pytest.raises(ValueError, match="unknown agent"):
        simulate(get_spec("kuhnish"), [{"agent": "gpt-5"}, {"agent": "random"}], 5)


def test_episode_cap_enforced() -> None:
    with pytest.raises(ValueError):
        simulate(get_spec("kuhnish"), [{"agent": "random"}, {"agent": "random"}],
                 EPISODE_LIMIT + 1)


def test_mini_bluff_variant_grid_all_valid_and_distinct() -> None:
    """§16/§17: typed mutations produce real, valid, distinct specs."""
    entry = GALLERY["mini-bluff"]
    seen: dict[str, str] = {}
    for ranks in entry.mutations["ranks"]:
        for bet in entry.mutations["bet_size"]:
            spec = load_ok = entry.variant(ranks=ranks, bet_size=bet)
            from rulezero.gamespec_ir import load_ir

            doc = load_ir(spec)
            h = ir_hash(doc)
            assert h not in seen or seen[h] == f"{ranks}/{bet}"
            seen[h] = f"{ranks}/{bet}"
            # every variant actually plays
            r = simulate(spec, [{"agent": "random"}, {"agent": "first"}],
                         episodes=20, seed=11)
            assert r["unfinished"] == 0
    # 3 rank decks × 3 bet sizes = 9 distinct variants
    assert len(seen) == 9


def test_agent_registry_exposes_cpu_agents() -> None:
    names = agent_names()
    assert "random" in names and "first" in names
