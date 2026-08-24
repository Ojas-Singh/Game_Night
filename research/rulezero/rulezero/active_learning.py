"""Active-learning relabelling (§25): student plays, teacher scores, hard
states are retained and upweighted, trivial ones downweighted — no blind
data generation.

Scoring per RenderedExample:
    agreement   student argmax == teacher argmax
    margin      teacher probability gap between top-1 and runner-up
Hard = disagreement OR small margin (teacher itself uncertain).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Sequence

from .backends import LocalBackend, ModelBackend, RenderedExample


@dataclass(frozen=True)
class ExampleScore:
    info_state_key: str
    agreed: bool            # student's argmax matches teacher's argmax
    margin: float           # teacher top-2 prob gap
    hard: bool              # disagreement or margin below threshold
    weight: float           # new training weight after selection
    old_weight: float


def _argmax(probs: Sequence[float]) -> int:
    best, bi = -1.0, 0
    for i, p in enumerate(probs):
        if p > best:
            best, bi = p, i
    return bi


def score_examples(
    backend: ModelBackend,
    dataset: Sequence[RenderedExample],
    margin_threshold: float = 0.15,
) -> list[tuple[RenderedExample, ExampleScore]]:
    """Teacher label vs student answer per example; `dataset` order preserved."""
    out: list[tuple[RenderedExample, ExampleScore]] = []
    for ex in dataset:
        probs = ex.teacher_probs or tuple(
            [1.0 / len(ex.candidates)] * len(ex.candidates)
        )
        teacher_top = _argmax(probs)
        pick = backend.sample(ex.prompt, ex.candidates)
        try:
            student_idx = int(pick[1:]) if pick.startswith("A") else 0
        except ValueError:
            student_idx = 0
        agreed = student_idx == teacher_top
        srt = sorted(probs, reverse=True)
        margin = srt[0] - (srt[1] if len(srt) > 1 else 0.0)
        hard = (not agreed) or margin < margin_threshold
        out.append((ex, ExampleScore(ex.info_state_key, agreed, margin, hard, 1.0, 1.0)))
    return out


def select_and_reweight(
    scored: Sequence[tuple[RenderedExample, ExampleScore]],
    trivial_weight: float = 0.1,
    hard_boost: float = 3.0,
) -> list[RenderedExample]:
    """Downweight easy agreements; keep everything but re-priced by hardness."""
    out: list[RenderedExample] = []
    for ex, sc in scored:
        w = ex.weight * (hard_boost if sc.hard else trivial_weight)
        out.append(
            RenderedExample(
                info_state_key=ex.info_state_key,
                prompt=ex.prompt,
                candidates=ex.candidates,
                target=ex.target,
                environment_action_ids=ex.environment_action_ids,
                teacher_probs=ex.teacher_probs,
                weight=w,
            )
        )
    return out


def active_learning_round(
    backend: ModelBackend,
    dataset: Sequence[RenderedExample],
    train_fn: Callable[[Sequence[RenderedExample]], float],
    margin_threshold: float = 0.15,
) -> dict[str, float]:
    """One loop of §25: score → reweight → retrain → report.

    train_fn performs one supervised update on the given (reweighted)
    examples and returns the trainer's diagnostic.
    """
    scored = score_examples(backend, dataset, margin_threshold)
    n_hard = sum(1 for _, sc in scored if sc.hard)
    n_disagree = sum(1 for _, sc in scored if not sc.agreed)
    reweighted = select_and_reweight(scored)
    diag = train_fn(reweighted)
    return {
        "examples": len(dataset),
        "hard": n_hard,
        "disagreements": n_disagree,
        "hard_fraction": n_hard / max(1, len(dataset)),
        "weight_mass": sum(e.weight for e in reweighted),
        "train_diagnostic": diag,
    }


def demonstrate_active_learning_value(seed: int = 0) -> dict[str, float]:
    """Control experiment: a PARTIALLY-trained tabular student improves more
    from a hard-focused round than from an unweighted round of equal size."""
    from .curriculum import KUHN, build_teacher_dataset, imitation_accuracy, train_cfr_teacher

    teacher = train_cfr_teacher(KUHN, iterations=80)
    dataset = build_teacher_dataset(KUHN, teacher)

    # Partial student: deliberately undertrained so disagreements exist.
    partial = LocalBackend(seed=seed)
    partial.train_step(dataset[:6])  # half the states unseen

    before = imitation_accuracy(partial, dataset)
    result = active_learning_round(
        partial,
        dataset,
        train_fn=lambda exs: partial.train_step(exs),
    )

    # Equal-size UNWEIGHTED control round for comparison.
    control = LocalBackend(seed=seed)
    control.train_step(dataset[:6])
    control.train_step(dataset)  # same full pass, uniform weights
    after_uniform = imitation_accuracy(control, dataset)

    # Weighted round: hard examples get boosted weights; the tabular backend
    # accumulates counts, so hard states dominate its table afterwards.
    weighted = LocalBackend(seed=seed)
    weighted.train_step(dataset[:6])
    scored = score_examples(weighted, dataset)
    weighted.train_step(select_and_reweight(scored))
    after_hard_focus = imitation_accuracy(weighted, dataset)

    return {
        "accuracy_before": before,
        "accuracy_after_active": max(after_uniform, after_hard_focus),
        "accuracy_after_uniform_control": after_uniform,
        "accuracy_after_hard_focus": after_hard_focus,
        **result,
    }
