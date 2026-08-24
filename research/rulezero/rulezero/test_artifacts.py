"""§19/§29 gates: artifact store provenance + trajectory schema recorder."""
from __future__ import annotations

import json
from pathlib import Path

import pyspiel
import pytest

from rulezero.artifacts import ArtifactStore, _git_commit
from rulezero.trajectory import (
    episodes_to_jsonl,
    record_episode,
    store_episodes,
)


def _random_policy(seed: int):
    state = seed

    def policy(info_state, candidates):
        nonlocal state
        state = (state * 1103515245 + 12345) % (2**31)
        return state % len(candidates)

    return policy


def test_record_kuhn_episode_matches_schema() -> None:
    game = pyspiel.load_game("kuhn_poker")
    ep = record_episode(
        game, {0: _random_policy(7), 1: _random_policy(9)},
        seed_schedule=[11], game_id="kuhn_poker",
    )
    assert ep["schemaVersion"] == 1
    assert len(ep["returns"]) == 2 and max(abs(r) for r in ep["returns"]) <= 2
    decisions = [t for t in ep["transitions"] if t["kind"] == "decision"]
    chances = [t for t in ep["transitions"] if t["kind"] == "chance"]
    assert chances and decisions  # kuhn deals then decides
    for t in decisions:
        assert t["infoState"] is not None          # perfect-recall input (§7)
        ids = [c["candidateId"] for c in t["candidates"]]
        assert ids == [f"A{i}" for i in range(len(ids))]      # dense (§8)
        assert t["chosenCandidateId"] in ids
        chosen = next(c for c in t["candidates"] if c["candidateId"] == t["chosenCandidateId"])
        assert chosen["environmentActionId"] in t["legalEnvironmentActions"]
        assert t["valueTarget"] is None and t["beliefTarget"] is None  # §29 reserved
    # chance transitions record sampled outcomes; replay reproduces returns
    assert ep["seedSchedule"] == [int(t["chosenEnvironmentActionId"]) for t in chances]


def test_jsonl_is_canonical_and_replayable(tmp_path: Path) -> None:
    game = pyspiel.load_game("kuhn_poker")
    eps = [
        record_episode(game, {0: _random_policy(s), 1: _random_policy(s + 1)},
                       seed_schedule=[s], game_id="kuhn_poker")
        for s in (3, 5)
    ]
    blob = episodes_to_jsonl(eps)
    lines = blob.decode().splitlines()
    assert len(lines) == 2
    # canonical JSON ⇒ identical episodes serialize identically
    again = [record_episode(game, {0: _random_policy(s), 1: _random_policy(s + 1)},
                            seed_schedule=[s], game_id="kuhn_poker") for s in (3, 5)]
    # trajectoryIds are timestamps — compare structure minus that field
    strip = lambda e: {k: v for k, v in e.items() if k != "trajectoryId"}
    assert [strip(json.loads(l)) for l in lines] == [strip(e) for e in again]


def test_artifact_store_provenance_and_immutability(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path / "artifacts")
    data = b"episode-jsonl-bytes"
    aid = store.put(data, kind="trajectories", config_hash="cfg-1",
                    parents=["parent-artifact"], meta={"game": "kuhn"})
    assert store.has(aid)
    m = store.manifest(aid)
    assert m["artifactId"] == aid
    assert m["producingCommit"] in (_git_commit(), "unknown") and len(m["producingCommit"]) >= 7
    assert m["configHash"] == "cfg-1"
    assert m["parents"] == ["parent-artifact"]
    assert m["timestamp"].endswith("Z")
    assert store.get(aid) == data

    # idempotent re-put of identical bytes is fine…
    assert store.put(data, kind="trajectories") == aid
    # …and the manifest is untouched by it
    assert store.manifest(aid)["meta"] == {"game": "kuhn"}


def test_store_roundtrip_through_trajectory_path(tmp_path: Path) -> None:
    game = pyspiel.load_game("kuhn_poker")
    eps = [record_episode(game, {0: _random_policy(2), 1: _random_policy(2)},
                          seed_schedule=[2], game_id="kuhn_poker")]
    store = ArtifactStore(tmp_path)
    aid = store_episodes(store, eps, config_hash="exp-42")
    loaded = [json.loads(l) for l in store.get(aid).decode().splitlines()]
    strip = lambda e: {k: v for k, v in e.items() if k != "trajectoryId"}
    assert [strip(e) for e in loaded] == [strip(eps[0])]
    assert store.manifest(aid)["meta"]["episodes"] == 1


def test_unknown_artifact_raises() -> None:
    store = ArtifactStore(Path("/tmp/rz-test-store-x"))
    with pytest.raises(KeyError):
        store.get("deadbeef" * 8)
