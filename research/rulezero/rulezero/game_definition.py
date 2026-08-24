"""GameDefinition bundle (§14) + game-level split registry (§27).

ONE canonical object is what the rest of Game Night refers to: the GameSpec,
its normalized rules text, spec hash, presentation hints, benchmark metadata
and — critically for the unseen-game benchmark — its curriculum split
membership. Splits are assigned per FAMILY id deterministically BEFORE any
generation, so "held-out" is provable, not aspirational.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

SPLITS = ("train", "val", "test")
DEFAULT_RATIOS = {"train": 0.7, "val": 0.15, "test": 0.15}

# Procedural generator seed ranges are partitioned by split (§27): a test
# family can never be generated from a train seed range.
SEED_RANGES: dict[str, tuple[int, int]] = {
    "train": (10_000, 39_999),
    "val": (40_000, 44_999),
    "test": (45_000, 49_999),
}


def canonical_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


@dataclass
class GameDefinition:
    """The single artifact everything else references (§14)."""

    family_id: str                      # e.g. 'kuhnish', 'goofseq-family-3'
    spec: dict[str, Any]                # GameSpec v1 JSON (data only)
    rules_text: str                     # normalized natural-language rules
    presentation: dict[str, Any] = field(default_factory=dict)   # renderer hints
    benchmark: dict[str, Any] = field(default_factory=dict)      # eval metadata
    split: str | None = None            # assigned via assign_split()

    @property
    def spec_hash(self) -> str:
        return hashlib.sha256(canonical_json(self.spec).encode()).hexdigest()

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, indent=2)

    @classmethod
    def from_json(cls, blob: str | Path) -> "GameDefinition":
        text = Path(blob).read_text() if isinstance(blob, (str, Path)) and "\n" not in str(blob) and str(blob).endswith(".json") else blob
        d = json.loads(text)
        return cls(
            family_id=d["family_id"],
            spec=d["spec"],
            rules_text=d["rules_text"],
            presentation=d.get("presentation", {}),
            benchmark=d.get("benchmark", {}),
            split=d.get("split"),
        )


def assign_split(family_id: str, ratios: dict[str, float] | None = None) -> str:
    """Deterministically map a family id to a split.

    sha256(family_id) → uniform [0,1); thresholds accumulate the ratios.
    Same id always lands in the same split on every machine and run.
    """
    ratios = {**(ratios or DEFAULT_RATIOS)}
    assert abs(sum(ratios.values()) - 1.0) < 1e-9, "split ratios must sum to 1"
    u = int(hashlib.sha256(family_id.encode()).hexdigest()[:16], 16) / float(16**16)
    acc = 0.0
    for name in SPLITS:
        acc += ratios[name]
        if u < acc:
            return name
    return SPLITS[-1]


def with_assigned_splits(defs: list[GameDefinition]) -> list[GameDefinition]:
    for d in defs:
        d.split = assign_split(d.family_id)
    return defs


def validate_no_leakage(defs: list[GameDefinition]) -> None:
    """A family id may appear in exactly ONE split; every def must carry one."""
    seen: dict[str, str] = {}
    for d in defs:
        if d.split is None:
            raise ValueError(f"{d.family_id}: missing split assignment")
        prev = seen.setdefault(d.family_id, d.split)
        if prev != d.split:
            raise ValueError(
                f"split leakage: {d.family_id} appears in both {prev} and {d.split}"
            )


def seed_range(split: str) -> tuple[int, int]:
    """Disjoint generator-seed interval per split (partitioned BEFORE use)."""
    return SEED_RANGES[split]


def seeds_for(split: str, n: int) -> list[int]:
    lo, hi = seed_range(split)
    span = hi - lo + 1
    step = max(1, span // max(1, n))
    return [lo + i * step for i in range(n)]
