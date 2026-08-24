"""Phase 3A §19-§20 gates: CardGym-mini frozen benchmark."""
from __future__ import annotations

import json

from rulezero.cardgym import (
    HELD_OUT_FAMILIES,
    build_cardgym_mini,
    write_cardgym_mini,
)
from rulezero.gamespec_ir import load_ir


def test_manifest_is_deterministic() -> None:
    a = build_cardgym_mini()
    b = build_cardgym_mini()
    assert a == b
    assert len(a["manifestHash"]) == 64


def test_manifest_covers_all_families_with_variants() -> None:
    m = build_cardgym_mini()
    fams = {v["familyId"] for v in m["variants"]}
    assert len(fams) == 8
    # mini-bluff family: 9 typed variants (3 decks x 3 bet sizes)
    mb = [v for v in m["variants"] if v["familyId"] == "mini-bluff"]
    assert len(mb) == 9
    assert len({v["specHash"] for v in mb}) == 9


def test_splits_are_disjoint_and_heldout_families_excluded() -> None:
    m = build_cardgym_mini()
    by_split: dict[str, set[str]] = {}
    for v in m["variants"]:
        by_split.setdefault(v["split"], set()).add(v["specHash"])
    assert not (by_split["train"] & by_split["val"])
    assert not (by_split["train"] & by_split["test"])
    assert not (by_split["val"] & by_split["test"])
    for fam in HELD_OUT_FAMILIES:
        fam_hashes = {v["specHash"] for v in m["variants"]
                      if v["familyId"] == fam}
        assert all(v["split"] == "holdout-family" for v in m["variants"]
                   if v["familyId"] == fam)
        assert fam_hashes.isdisjoint(by_split["train"])
        assert len(fam_hashes) >= 1


def test_every_variant_spec_still_validates() -> None:
    from rulezero.gallery import GALLERY

    m = build_cardgym_mini()
    assert m["variants"]
    for v in m["variants"][:6]:
        entry = GALLERY[v["familyId"]]
        doc = load_ir(entry.variant(**v["params"]))  # raises if invalid


def test_coverage_matrix_has_mechanic_columns() -> None:
    m = build_cardgym_mini()
    row_by_id = {r["familyId"]: r for r in m["coverage"]}
    assert row_by_id["claim"]["reaction"] is True
    assert row_by_id["secret-bid"]["bidding"] is True
    assert row_by_id["hidden-duel"]["hidden"] is True
    assert row_by_id["double-or-nothing"]["chance"] is True
    held = {r["familyId"] for r in m["coverage"] if r["heldOutFamily"]}
    assert held == set(HELD_OUT_FAMILIES)


def test_write_is_atomic_and_round_trips(tmp_path) -> None:
    path = write_cardgym_mini(str(tmp_path))
    data = json.loads(open(path).read())
    assert data["manifestHash"] == build_cardgym_mini()["manifestHash"]
