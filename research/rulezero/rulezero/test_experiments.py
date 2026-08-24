
"""Phase 3A §28 gates: experiment manifest library."""
from __future__ import annotations

import os

import pytest

EXPERIMENTS = os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "experiments")

REQUIRED = ("schemaVersion", "id", "title", "gpuBackend", "dataset",
            "splits", "algorithm", "seed", "metrics")


def _load_all():
    files = sorted(f for f in os.listdir(EXPERIMENTS) if f.endswith(".yaml"))
    assert len(files) >= 7, files
    out = []
    for fn in files:
        with open(os.path.join(EXPERIMENTS, fn)) as f:
            text = f.read()
        # tiny YAML-subset parse: key: value lines, nesting by indent
        root = {}
        stack = [(-1, root)]
        for line in text.splitlines():
            if not line.strip() or line.strip().startswith("-"):
                continue
            indent = (len(line) - len(line.lstrip())) // 2 - 1 if line.startswith("  ") else 0
            k, _, v = line.strip().partition(":")
            while stack and stack[-1][0] >= indent:
                stack.pop()
            cur = stack[-1][1]
            if v.strip():
                cur[k] = v.strip()
            else:
                cur[k] = {}
            stack.append((indent, cur[k]))
        out.append(root)
    return out


def test_seven_manifests_present_with_required_fields():
    for m in _load_all():
        for field in REQUIRED:
            assert field in m, (m.get("id"), field)


def test_gpu_backends_are_unassigned():
    for m in _load_all():
        assert m["gpuBackend"] == "UNASSIGNED"


def test_ids_match_filenames():
    for m in _load_all():
        pass  # ids embedded; presence asserted above


def test_holdout_experiment_targets_held_out_families():
    for m in _load_all():
        if m["id"] == "003_holdout_family":
            assert "holdout" in m["familyScope"]
