"""CardGym-mini (Phase 3A §19-§20): a FROZEN generalization benchmark built
from the Game Lab gallery.

- Variant-level splits for mutable families (train/val/test by seed range).
- Entire held-out families that never appear in training data (§19).
- Deterministic output: identical bytes for identical generator version,
  enforced by canonical JSON + SHA-256 over the manifest.

This is the dataset/experiment contract the future GPU consumes on day one.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from .gallery import GALLERY
from .gamespec_ir import ir_hash, load_ir

GENERATOR_VERSION = 1

# Whole families reserved from training forever (§19).
HELD_OUT_FAMILIES = frozenset({"claim", "double-or-nothing"})

# Mechanic-combination coverage columns (§20).
MECHANIC_COLUMNS = ("hidden", "chance", "bluffing", "bidding",
                    "reaction", "push-luck")

_TAG_TO_MECHANIC = {
    "Hidden Information": "hidden",
    "Chance": "chance",
    "Bluffing": "bluffing",
    "Resource Bidding": "bidding",
    "Reaction": "reaction",
    "Push-Your-Luck": "push-luck",
}


def _capabilities(tags: list[str]) -> dict[str, Any]:
    mechanics = [m for t in tags if (m := _TAG_TO_MECHANIC.get(t))]
    return {"mechanics": sorted(set(mechanics)),
            "players": 2 if "2 Players" in tags else None}


def _split_for(family_id: str, variant_index: int, n_variants: int) -> str:
    """Deterministic variant-level split: last fifth test, previous fifth
    val, rest train — keyed only by stable ordering, no randomness."""
    if n_variants <= 1:
        return "train"
    first_test = max(1, n_variants - max(1, n_variants // 5))
    first_val = max(0, first_test - max(1, n_variants // 5))
    if variant_index >= first_test:
        return "test"
    if variant_index >= first_val:
        return "val"
    return "train"


def build_cardgym_mini() -> dict[str, Any]:
    """Build the full frozen manifest as plain JSON-able data."""
    variants_out: list[dict[str, Any]] = []
    coverage_rows: list[dict[str, Any]] = []

    for gid in sorted(GALLERY):
        entry = GALLERY[gid]
        caps = _capabilities(entry.tags)
        # Enumerate this family's variants: mutations grid or single base.
        combos: list[dict[str, Any]] = [{}]
        param_names = sorted(entry.mutations.keys())
        if param_names:
            combos = [dict(zip(param_names, values))
                      for values in _grid(entry.mutations, param_names)]
        fam_variants = []
        for idx, params in enumerate(combos):
            spec = load_ir(entry.variant(**params))
            h = ir_hash(spec)
            fam_variants.append({
                "familyId": gid,
                "variantId": f"{gid}-v{idx:02d}",
                "specHash": h,
                "params": params,
                "capabilities": caps,
                "split": (_split_for(gid, idx, len(combos))
                          if gid not in HELD_OUT_FAMILIES else "holdout-family"),
                "generatorVersion": GENERATOR_VERSION,
            })
        variants_out.extend(fam_variants)
        coverage_rows.append({
            "familyId": gid,
            "title": entry.title,
            **{col: (col in caps["mechanics"]) for col in MECHANIC_COLUMNS},
            "variants": len(fam_variants),
            "heldOutFamily": gid in HELD_OUT_FAMILIES,
        })

    manifest = {
        "schemaVersion": 1,
        "name": "cardgym-mini",
        "generatorVersion": GENERATOR_VERSION,
        "heldOutFamilies": sorted(HELD_OUT_FAMILIES),
        "splitsPolicy": (
            "variant-level train/val/test for mutable families; "
            "held-out families excluded entirely"),
        "coverageColumns": list(MECHANIC_COLUMNS),
        "coverage": coverage_rows,
        "variants": variants_out,
    }
    body = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    manifest["manifestHash"] = hashlib.sha256(body.encode()).hexdigest()
    return manifest


def _grid(mutations: dict[str, list[Any]],
          names: list[str]) -> list[tuple[Any, ...]]:
    """Cartesian product over typed mutation grids (small by design)."""
    out: list[tuple[Any, ...]] = [()]

    def rec(i: int, acc: tuple[Any, ...]) -> None:
        if i == len(names):
            out.append(acc)
            return
        for v in mutations[names[i]]:
            rec(i + 1, acc + (v,))

    if names:
        out = []
        rec(0, ())
    return out


def write_cardgym_mini(out_dir: str | None = None) -> str:
    """Write the frozen manifest to reports/cardgym-mini.json."""
    import os

    root = out_dir or os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "reports")
    os.makedirs(root, exist_ok=True)
    path = os.path.join(root, "cardgym-mini.json")
    manifest = build_cardgym_mini()
    with open(path + ".tmp", "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
    os.replace(path + ".tmp", path)
    return path
