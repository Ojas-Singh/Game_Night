
"""Phase 3A §38 gates: share/fork generated games."""
from __future__ import annotations

import os

import pytest

from rulezero import service
from rulezero.gallery import get_spec


@pytest.fixture()
def shares_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("RULEZERO_SHARES", str(tmp_path))
    return tmp_path


def test_share_then_resolve_round_trip(shares_dir):
    _, r = service.handle(None, {"op": "labShare", "galleryId": "mini-bluff",
                                 "params": {"ranks": [1, 2, 3], "bet_size": 2}})
    assert r["ok"]
    sid = r["shareId"]
    assert sid.startswith("mini-bluff-") and len(sid) == len("mini-bluff-") + 8
    _, r2 = service.handle(None, {"op": "labResolveShared", "shareId": sid})
    assert r2["ok"] and r2["specHash"] == r["specHash"]
    # resolved spec is playable and matches the family generator output
    from rulezero.gamespec_ir import ir_hash

    assert r2["specHash"] == ir_hash(
        __import__("rulezero.gallery", fromlist=["GALLERY"])
        .GALLERY["mini-bluff"].variant(ranks=[1, 2, 3], bet_size=2))


def test_unknown_share_rejected_and_ids_sanitized(shares_dir):
    _, r = service.handle(None, {"op": "labResolveShared",
                                 "shareId": "../../etc/passwd"})
    assert not r["ok"]
    _, r2 = service.handle(None, {"op": "labResolveShared",
                                  "shareId": "never-exists-00000000"})
    assert r2["error"] == "unknown share"


def test_share_record_is_pure_data(shares_dir):
    _, r = service.handle(None, {"op": "labShare", "galleryId": "claim",
                                 "params": {}})
    path = shares_dir / f"{r['shareId']}.json"
    import json

    rec = json.loads(path.read_text())
    assert set(rec) <= {"schemaVersion", "galleryId", "params",
                        "specHash", "title"}
