"""ModelBackend / TrainingAlgorithm separation (§21).

Architecture rules enforced here:
- Environment/solver code NEVER imports a model provider. Only backends do,
  and provider imports are lazy (inside methods), so `import rulezero.backends`
  stays cheap and provider-free (§22, §32 gate).
- Experiment DATA is backend-agnostic: a rendered example is plain data, so
  the identical dataset can target LocalBackend or TinkerBackend.
- Checkpoints/artifacts are small JSON manifests (§19); weights live outside
  Git for real model stores.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Sequence


# ---------------------------------------------------------------------------
# Data contracts
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ModelMetadata:
    """Everything an experiment manifest must record about a model (§22)."""

    backend_kind: str            # 'local' | 'tinker' | ...
    model_id: str                # provider-specific id ('tabular-v0', 'qwen3.5-4b', ...)
    renderer: str                # rendering scheme name, e.g. 'rulezero-action-only-v1'
    seed: int
    lora_rank: int | None = None
    sdk_version: str | None = None   # e.g. tinker SDK version when known
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RenderedExample:
    """One supervision example. Backend-agnostic by construction."""

    info_state_key: str          # canonical information-state identity
    prompt: str                  # fully-rendered model input text
    candidates: tuple[str, ...]  # dense candidate ids 'A0'..'An' (§8)
    target: str                  # gold candidateId
    # candidateId -> environment action id, plus optional teacher distribution
    environment_action_ids: tuple[int, ...]
    teacher_probs: tuple[float, ...] | None = None
    weight: float = 1.0          # active-learning downweighting lands here (§25)

    def dataset_hash(self) -> str:
        payload = json.dumps(
            {
                "key": self.info_state_key,
                "prompt": self.prompt,
                "candidates": self.candidates,
                "target": self.target,
                "eaid": self.environment_action_ids,
                "probs": self.teacher_probs,
                "w": self.weight,
            },
            sort_keys=True,
        )
        return hashlib.sha256(payload.encode()).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(Path(path).read_bytes())
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Backend interface
# ---------------------------------------------------------------------------


class ModelBackend(ABC):
    """A trainable sampling policy store (§21).

    Responsibilities: rendering, sampling, training primitive, checkpoints,
    metadata. NOTHING here knows about games; examples arrive pre-rendered.
    """

    @abstractmethod
    def metadata(self) -> ModelMetadata: ...

    @abstractmethod
    def train_step(self, examples: Sequence[RenderedExample]) -> float:
        """One supervised update; returns loss-ish diagnostic."""

    @abstractmethod
    def sample(self, prompt: str, candidates: Sequence[str]) -> str:
        """Return the chosen candidateId for this prompt."""

    @abstractmethod
    def save(self, path: Path) -> None: ...

    @abstractmethod
    def load(self, path: Path) -> None: ...


class TrainingAlgorithm(ABC):
    """Consumes a backend + dataset; owns loops/schedules, not providers."""

    name: str

    @abstractmethod
    def run(
        self,
        backend: ModelBackend,
        dataset: Sequence[RenderedExample],
        epochs: int = 1,
        seed: int = 0,
    ) -> dict[str, Any]:
        """Train; return summary metrics for the manifest."""


# ---------------------------------------------------------------------------
# LocalBackend: deterministic tabular policy (offline reference backend)
# ---------------------------------------------------------------------------


class LocalBackend(ModelBackend):
    """Exact-memorization tabular backend.

    Not a research *model* — it is the offline control that proves the whole
    train→checkpoint→evaluate pipeline deterministically and gives every
    experiment a floor baseline. Prompt hashing keys the policy table.
    """

    def __init__(self, seed: int = 0, model_id: str = "tabular-v0") -> None:
        self._meta = ModelMetadata(
            backend_kind="local",
            model_id=model_id,
            renderer="rulezero-action-only-v1",
            seed=seed,
            sdk_version=f"python-{platform.python_version()}",
        )
        self.seed = seed
        # prompt-hash -> {candidateId: pseudo-count}
        self.table: dict[str, dict[str, float]] = {}
        self.steps = 0

    def metadata(self) -> ModelMetadata:
        return self._meta

    @staticmethod
    def _key(prompt: str) -> str:
        return hashlib.sha256(prompt.encode()).hexdigest()

    def train_step(self, examples: Sequence[RenderedExample]) -> float:
        if not examples:
            return 0.0
        wrong = 0
        for ex in examples:
            key = self._key(ex.prompt)
            bucket = self.table.setdefault(key, {})
            bucket[ex.target] = bucket.get(ex.target, 0.0) + ex.weight
            best = max(bucket.items(), key=lambda kv: (kv[1], kv[0]))[0]
            if best != ex.target:
                wrong += 1
        self.steps += 1
        return wrong / len(examples)

    def sample(self, prompt: str, candidates: Sequence[str]) -> str:
        bucket = self.table.get(self._key(prompt))
        if not bucket:
            # Unseen state: deterministic fallback to first candidate.
            return candidates[0] if candidates else ""
        best = max(bucket.items(), key=lambda kv: (kv[1], kv[0]))[0]
        if best in candidates:
            return best
        return candidates[0] if candidates else ""

    def probs(self, prompt: str, candidates: Sequence[str]) -> list[float]:
        """Smoothed empirical distribution (used by evaluation/diagnostics)."""
        bucket = self.table.get(self._key(prompt), {})
        counts = [max(bucket.get(c, 0.0), 0.0) + 1e-9 for c in candidates]
        total = sum(counts)
        return [c / total for c in counts]

    def save(self, path: Path) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "format": "rulezero-local-checkpoint/v1",
            "metadata": asdict(self.metadata()),
            "steps": self.steps,
            "table": self.table,
        }
        Path(path).write_text(json.dumps(payload, sort_keys=True))

    def load(self, path: Path) -> None:
        payload = json.loads(Path(path).read_text())
        if payload.get("format") != "rulezero-local-checkpoint/v1":
            raise ValueError("unknown checkpoint format")
        md = payload["metadata"]
        self._meta = ModelMetadata(**md)
        self.steps = payload["steps"]
        self.table = payload["table"]


class SFT(TrainingAlgorithm):
    """Supervised fine-tuning loop over any backend."""

    name = "sft"

    def run(
        self,
        backend: ModelBackend,
        dataset: Sequence[RenderedExample],
        epochs: int = 1,
        seed: int = 0,
    ) -> dict[str, Any]:
        del seed  # shuffling handled by caller for reproducibility
        losses: list[float] = []
        for _ in range(max(1, epochs)):
            losses.append(backend.train_step(dataset))
        return {
            "algorithm": self.name,
            "epochs": epochs,
            "examples": len(dataset),
            "final_epoch_error_rate": losses[-1] if losses else None,
        }


# ---------------------------------------------------------------------------
# TinkerBackend: remote GPU backend behind the SAME interface (§22)
# ---------------------------------------------------------------------------

_TINKER_ENV_FLAG = "RULEZERO_ENABLE_TINKER"


class TinkerBackend(ModelBackend):
    """Thin adapter to the official Tinker SDK. Import happens lazily inside
    methods so nothing in RuleZero transitively loads tinker until a Tinker
    experiment actually runs, and environments can never see it (§33)."""

    def __init__(
        self,
        model_id: str,
        service_name: str | None = None,
        lora_rank: int = 8,
        seed: int = 0,
        renderer: str = "rulezero-action-only-v1",
    ) -> None:
        if os.environ.get(_TINKER_ENV_FLAG, "").lower() not in {"1", "true", "yes"}:
            raise RuntimeError(
                f"TinkerBackend requires {_TINKER_ENV_FLAG}=1; "
                "RuleZero must stay provider-free by default"
            )
        self.model_id = model_id
        self.service_name = service_name
        self.lora_rank = lora_rank
        self.seed = seed
        self.renderer = renderer
        self._sdk_version: str | None = None
        self._service = None  # lazily created

    def metadata(self) -> ModelMetadata:
        return ModelMetadata(
            backend_kind="tinker",
            model_id=self.model_id,
            renderer=self.renderer,
            seed=self.seed,
            lora_rank=self.lora_rank,
            sdk_version=self._sdk_version,
            extra={"service_name": self.service_name},
        )

    def _connect(self) -> Any:
        import tinker  # lazy: only when a Tinker run starts (§22)

        self._sdk_version = getattr(tinker, "__version__", "unknown")
        if self._service is None:
            self._service = (
                tinker.ServiceClient(service_name=self.service_name)
                if self.service_name
                else tinker.ServiceClient()
            )
        return self._service

    def _assert_enabled(self) -> None:
        if self._service is None:
            self._connect()

    def train_step(self, examples: Sequence[RenderedExample]) -> float:
        self._assert_enabled()
        # Real wiring lands with the first live Tinker run; the datum shape
        # below is what the SDK's training forward/backward consumes.
        datum = [
            {
                "prompt": ex.prompt,
                "target": ex.target,
                "weight": ex.weight,
            }
            for ex in examples
        ]
        raise NotImplementedError(
            f"tinker training step pending first live run ({len(datum)} datums)"
        )

    def sample(self, prompt: str, candidates: Sequence[str]) -> str:
        self._assert_enabled()
        raise NotImplementedError("tinker sampling pending first live run")

    def save(self, path: Path) -> None:
        self._assert_enabled()
        raise NotImplementedError("tinker checkpoint download pending")

    def load(self, path: Path) -> None:
        self._assert_enabled()
        raise NotImplementedError("tinker checkpoint load pending")


def get_backend(kind: str, **kwargs: Any) -> ModelBackend:
    """Registry lookup used by experiment configs (data-driven backend choice)."""
    if kind == "local":
        return LocalBackend(**kwargs)
    if kind == "tinker":
        return TinkerBackend(**kwargs)
    raise ValueError(f"unknown backend kind: {kind}")
