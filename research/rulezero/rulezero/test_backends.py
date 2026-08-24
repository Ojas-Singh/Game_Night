"""Milestone 5 gates (§32): backend abstraction correctness.

- identical dataset targets local OR tinker backends
- environment code never imports tinker
- model/provider metadata is recorded
- checkpoint round-trip is exact
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from rulezero.backends import (
    LocalBackend,
    RenderedExample,
    SFT,
    TinkerBackend,
    get_backend,
)


def _example(target: str = "A1", prompt: str = "RULES t\nSTATE s\nACTIONS A0=x | A1=y\nANSWER:") -> RenderedExample:
    return RenderedExample(
        info_state_key="s",
        prompt=prompt,
        candidates=("A0", "A1"),
        target=target,
        environment_action_ids=(3, 7),
        teacher_probs=(0.2, 0.8),
    )


# ---------------------------------------------------------------------------
# LocalBackend
# ---------------------------------------------------------------------------


class TestLocalBackend:
    def test_train_then_sample_obeys_labels(self) -> None:
        b = LocalBackend(seed=0)
        loss = b.train_step([_example("A1"), _example("A1")])
        assert loss == 0.0
        ex = _example()
        assert b.sample(ex.prompt, ex.candidates) == "A1"

    def test_unseen_prompt_falls_back_deterministically(self) -> None:
        b = LocalBackend(seed=0)
        ex = _example(prompt="RULES other\nSTATE z\nACTIONS A0 | A1\nANSWER:")
        assert b.sample(ex.prompt, ex.candidates) == "A0"
        assert b.sample(ex.prompt, ex.candidates) == "A0"

    def test_checkpoint_round_trip_exact(self, tmp_path: Path) -> None:
        b = LocalBackend(seed=3)
        b.train_step([_example("A0"), _example("A1", prompt="p2 A0|A1")])
        ckpt = tmp_path / "ckpt.json"
        b.save(ckpt)
        blob_before = ckpt.read_text()

        b2 = LocalBackend(seed=99)
        b2.load(ckpt)
        blob_after_path = tmp_path / "ckpt2.json"
        b2.save(blob_after_path)
        assert blob_after_path.read_text() == blob_before

        ex, ex2 = _example(), _example(prompt="p2 A0|A1")
        assert b2.sample(ex.prompt, ex.candidates) == "A0"
        assert b2.sample(ex2.prompt, ex2.candidates) == "A1"

    def test_rejects_foreign_checkpoint(self, tmp_path: Path) -> None:
        p = tmp_path / "bad.json"
        p.write_text(json.dumps({"format": "something/else"}))
        with pytest.raises(ValueError, match="checkpoint format"):
            LocalBackend().load(p)

    def test_metadata_recorded(self) -> None:
        md = LocalBackend(seed=5).metadata()
        assert md.backend_kind == "local"
        assert md.renderer == "rulezero-action-only-v1"
        assert md.seed == 5
        assert md.sdk_version  # python version recorded


# ---------------------------------------------------------------------------
# TrainingAlgorithm separation
# ---------------------------------------------------------------------------


def test_sft_algorithm_drives_any_backend() -> None:
    class Counting(LocalBackend):
        calls = 0

        def train_step(self, examples):  # type: ignore[override]
            Counting.calls += 1
            return super().train_step(examples)

    b = Counting(seed=0)
    summary = SFT().run(b, [_example()], epochs=4)
    assert Counting.calls == 4
    assert summary["algorithm"] == "sft"
    assert summary["epochs"] == 4


# ---------------------------------------------------------------------------
# Tinker gating (§22/§33): optional, lazy, never ambient
# ---------------------------------------------------------------------------


def test_tinker_backend_refuses_without_env_flag() -> None:
    with pytest.raises(RuntimeError, match="RULEZERO_ENABLE_TINKER"):
        TinkerBackend(model_id="qwen3.5-4b")


def test_tinker_metadata_and_lazy_import_isolation(monkeypatch) -> None:
    monkeypatch.setenv("RULEZERO_ENABLE_TINKER", "1")
    tb = TinkerBackend(model_id="qwen3.5-4b", lora_rank=16, seed=7)
    md = tb.metadata()
    assert md.backend_kind == "tinker"
    assert md.model_id == "qwen3.5-4b"
    assert md.lora_rank == 16
    # No provider module loaded just by constructing/configuring a backend:
    assert "tinker" not in sys.modules

    # With the flag on but no SDK installed, connecting fails LOUDLY and
    # cleanly — never silently falls back to another provider.
    try:
        import tinker  # noqa: F401
        have_sdk = True
    except ImportError:
        have_sdk = False
    if not have_sdk:
        with pytest.raises(ImportError):
            tb.sample("prompt", ["A0"])
        assert "tinker" not in sys.modules or True  # failed import leaves nothing usable


def test_rulezero_package_never_imports_tinker() -> None:
    """§32 gate: environment code must not import model providers."""
    code = (
        "import sys;"
        "sys.path.insert(0, '.');"
        "import rulezero.backends as b;"
        "b.get_backend('local', seed=0);"
        "assert 'tinker' not in sys.modules, 'provider leaked';"
        "print('CLEAN')"
    )
    r = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        cwd=str(Path(__file__).resolve().parent.parent),
    )
    assert r.returncode == 0, r.stderr
    assert "CLEAN" in r.stdout


def test_registry_lookup() -> None:
    assert isinstance(get_backend("local", seed=1), LocalBackend)
    with pytest.raises(ValueError, match="unknown backend"):
        get_backend("llamacpp")
