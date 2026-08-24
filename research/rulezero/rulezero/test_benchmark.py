"""Zero-shot benchmark gates (M6/§27/§35): held-out GameSpec families only."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from rulezero.backends import LocalBackend
from rulezero.benchmark import (
    UnseenFamilyError,
    enforce_unseen,
    play_spec_games,
    run_zero_shot_benchmark,
)
from rulezero.game_definition import GameDefinition, assign_split
from rulezero.test_ir_games import CLAIM, GOOFSEQ, KUHNISH


def _defn(family: str, spec: dict) -> GameDefinition:
    return GameDefinition(
        family_id=family,
        spec=spec,
        rules_text=f"Held-out family {family}: play legally and sensibly.",
        split=assign_split(family),
    )


KUHNISH_D = _defn("kuhnish", dict(KUHNISH))
GOOFSEQ_D = _defn("goofseq", dict(GOOFSEQ))
CLAIM_D = _defn("claim", dict(CLAIM))


def test_refuses_seen_families() -> None:
    with pytest.raises(UnseenFamilyError):
        enforce_unseen([KUHNISH_D], seen_families={"kuhnish"})
    # unseen passes silently
    enforce_unseen([KUHNISH_D], seen_families={"goofseq", "claim"})


def test_plays_held_out_game_legally() -> None:
    backend = LocalBackend(seed=0)  # untrained: pure fallback policy
    r = play_spec_games(KUHNISH_D, backend, n_episodes=100, seed=7)
    assert r["games"] == 100
    assert r["decisions"] > 0
    assert r["illegal_forced"] == 0
    assert r["parse_failures"] == 0
    assert abs(r["avg_return_p0"]) < 3.0  # bounded returns


def test_benchmark_manifest_and_leakage_guard(tmp_path: Path) -> None:
    backend = LocalBackend(seed=0)
    m = run_zero_shot_benchmark(
        backend,
        [GOOFSEQ_D, CLAIM_D],
        seen_families={"kuhnish"},  # trained on kuhnish only
        out_dir=tmp_path,
        episodes_per_game=60,
        seed=3,
    )
    assert m["held_out_families"] == ["goofseq", "claim"]
    assert "kuhnish" in m["seen_families"]
    for fam in ("goofseq", "claim"):
        r = m["results"][fam]
        assert r["illegal_forced"] == 0
        assert r["decisions"] > 0
        assert len(r["spec_hash"]) == 64
    assert (tmp_path / "manifest.json").exists()
    blob = json.loads((tmp_path / "manifest.json").read_text())
    assert blob == m


def test_benchmark_refuses_trained_family_in_results(tmp_path: Path) -> None:
    with pytest.raises(UnseenFamilyError):
        run_zero_shot_benchmark(
            LocalBackend(seed=0),
            [KUHNISH_D],
            seen_families={"kuhnish"},
            out_dir=tmp_path,
        )


def test_determinism_same_seed_same_result() -> None:
    a = play_spec_games(GOOFSEQ_D, LocalBackend(seed=1), n_episodes=50, seed=11)
    b = play_spec_games(GOOFSEQ_D, LocalBackend(seed=1), n_episodes=50, seed=11)
    assert a == b


def test_backend_player_one_supported() -> None:
    r = play_spec_games(KUHNISH_D, LocalBackend(seed=0), 60, seed=5, backend_player=1)
    assert "avg_return_p1" in r
    assert r["illegal_forced"] == 0


def test_invalid_spec_is_rejected_before_play() -> None:
    bad = _defn("broken", {"schemaVersion": 1})  # missing everything
    with pytest.raises(Exception):
        play_spec_games(bad, LocalBackend(seed=0), 10)
