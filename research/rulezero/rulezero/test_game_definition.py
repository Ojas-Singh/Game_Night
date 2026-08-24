"""M6 gates: active-learning relabelling (§25) + GameDefinition/splits (§14/§27)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from rulezero.active_learning import (
    active_learning_round,
    score_examples,
    select_and_reweight,
)
from rulezero.backends import LocalBackend
from rulezero.curriculum import KUHN, LEDUC, build_teacher_dataset, train_cfr_teacher
from rulezero.game_definition import (
    SEED_RANGES,
    GameDefinition,
    assign_split,
    seed_range,
    seeds_for,
    validate_no_leakage,
    with_assigned_splits,
)


# ---------------------------------------------------------------------------
# §25 active learning
# ---------------------------------------------------------------------------


def _dataset():
    teacher = train_cfr_teacher(KUHN, iterations=80)
    return build_teacher_dataset(KUHN, teacher)


def test_scores_mark_disagreements_hard() -> None:
    ds = _dataset()
    partial = LocalBackend(seed=0)
    partial.train_step(ds[:6])  # blind on the other 6 states
    scored = score_examples(partial, ds)
    unseen_agreed = [sc for ex, sc in scored if ex not in ds[:6]]
    assert any(not sc.agreed for sc in unseen_agreed), "partial student must disagree somewhere"
    assert all(sc.hard for _, sc in scored if not sc.agreed)


def test_reweight_boosts_hard_and_dampens_easy() -> None:
    ds = _dataset()
    partial = LocalBackend(seed=0)
    scored = score_examples(partial, ds)  # fully untrained → most are hard
    out = select_and_reweight(scored)
    hard_w = {e.weight for e, (_, s) in zip(out, scored) if s.hard}
    easy_w = {e.weight for e, (_, s) in zip(out, scored) if not s.hard}
    assert all(w == pytest.approx(3.0) for w in hard_w)
    assert all(w == pytest.approx(0.1) for w in easy_w)


def test_active_round_reports_and_trains() -> None:
    ds = _dataset()
    b = LocalBackend(seed=0)
    rep = active_learning_round(b, ds, train_fn=lambda exs: b.train_step(exs))
    assert rep["examples"] == len(ds) == 12
    assert 0.0 <= rep["hard_fraction"] <= 1.0
    assert rep["weight_mass"] > 0
    # the backend actually learned something it can act on
    assert b.sample(ds[0].prompt, ds[0].candidates) in ds[0].candidates


def test_active_learning_beats_uniform_control() -> None:
    """§25's core claim at control level: hard-focused relabelling must be at
    least as good as an equal-size uniform pass from the same start."""
    teacher = train_cfr_teacher(KUHN, iterations=80)
    ds = build_teacher_dataset(KUHN, teacher)

    def run(weighted: bool):
        b = LocalBackend(seed=0)
        b.train_step(ds[:6])
        if weighted:
            scored = score_examples(b, ds)
            data = select_and_reweight(scored)
        else:
            data = ds  # uniform weights
        b.train_step(data)
        correct = sum(
            1 for ex in ds if b.sample(ex.prompt, ex.candidates)
            == f"A{max(range(len(ex.teacher_probs)), key=lambda i: ex.teacher_probs[i])}"
        )
        return correct / len(ds)

    assert run(True) >= run(False)


# ---------------------------------------------------------------------------
# §14/§27 GameDefinition + splits
# ---------------------------------------------------------------------------


def _def(family: str) -> GameDefinition:
    return GameDefinition(
        family_id=family,
        spec={"schemaVersion": 1, "name": family},
        rules_text=f"Rules of {family}.",
    )


def test_spec_hash_is_canonical_and_stable() -> None:
    a = _def("x")
    a.spec = {"schemaVersion": 1, "players": {"count": 2}}
    b = _def("x")
    b.spec = {"players": {"count": 2}, "schemaVersion": 1}  # same dict, other order
    assert a.spec_hash == b.spec_hash
    assert len(a.spec_hash) == 64


def test_definition_json_round_trip(tmp_path: Path) -> None:
    d = _def("kuhnish")
    d.presentation = {"renderer": "generic-table"}
    d.benchmark = {"metric": "avg_return"}
    d.split = assign_split(d.family_id)
    p = tmp_path / "gd.json"
    p.write_text(d.to_json())
    d2 = GameDefinition.from_json(str(p))
    assert d2 == d


def test_assign_split_deterministic_and_partitioned() -> None:
    ids = [f"family-{i}" for i in range(200)]
    first = {fid: assign_split(fid) for fid in ids}
    again = {fid: assign_split(fid) for fid in ids}
    assert first == again
    values = set(first.values())
    assert values == {"train", "val", "test"}  # all three reachable


def test_no_family_spans_splits() -> None:
    defs = with_assigned_splits([_def(f"f{i}") for i in range(50)])
    validate_no_leakage(defs)
    dup = defs + [GameDefinition(**{**defs[0].to_dict(), "split": "test"})]
    with pytest.raises(ValueError, match="leakage"):
        validate_no_leakage(dup)


def test_seed_ranges_are_disjoint() -> None:
    ranges = list(SEED_RANGES.values())
    ranges.sort()
    for (lo1, hi1), (lo2, _) in zip(ranges, ranges[1:]):
        assert hi1 < lo2, "generator seed ranges must not overlap"
    assert seeds_for("train", 4)[0] >= seed_range("train")[0]
    assert seeds_for("test", 4)[-1] <= seed_range("test")[1]


def test_multi_game_defs_keep_own_hashes() -> None:
    k = GameDefinition(family_id="kuhn", spec={"a": 1}, rules_text="")
    l = GameDefinition(family_id="leduc", spec={"a": 1}, rules_text="")
    assert k.spec_hash == l.spec_hash  # hash covers SPEC only, not family
    l.spec = {"a": 2}
    assert k.spec_hash != l.spec_hash
