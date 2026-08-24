"""Natural-language → GameSpec compile pipeline (§13/§30).

The LLM writes FORMAL rules (a GameSpec draft); deterministic gates decide
acceptance. The LLM is never the runtime, never executes, and ambiguity is
surfaced — never silently invented semantics.

Pipeline:
    rules text ──RuleCompilerLLM──▶ draft spec + report fields
                                     │
                                     ▼
                        validate_ir (static gates, §11)
                                     ▼
                        semantic smoke (random simulation, §12)
                                     ▼
                     CompiledGame (accepted) | CompileFailure

The compiler interface is provider-free like ModelBackend: concrete LLM
implementations plug in later; the stub here exists ONLY to exercise the
pipeline deterministically in tests.
"""
from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from .game_definition import GameDefinition, assign_split
from .gamespec_ir import IRValidationError, ir_hash, load_ir


# ---------------------------------------------------------------------------
# Compiler interface
# ---------------------------------------------------------------------------


@dataclass
class DraftReport:
    """What a rule compiler must disclose alongside its draft (§13)."""

    ambiguities: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    unsupported_mechanics: list[str] = field(default_factory=list)


class RuleCompilerLLM(ABC):
    """A rule compiler produces DATA (spec JSON), never code."""

    name: str = "abstract"

    @abstractmethod
    def compile(self, rules_text: str) -> tuple[dict[str, Any], DraftReport]:
        """Return (draft GameSpec dict, disclosure report)."""


class DeterministicStubCompiler(RuleCompilerLLM):
    """Fixed-output compiler used to test the pipeline end-to-end offline.

    It 'compiles' only the one rules text it knows, and honestly reports an
    assumption + an unsupported mechanic — modelling the disclosure contract.
    """

    name = "stub-kuhnish-v0"
    _KNOWN = "two players each ante one token"

    def compile(self, rules_text: str) -> tuple[dict[str, Any], DraftReport]:
        if self._KNOWN not in rules_text:
            return {}, DraftReport(
                ambiguities=[
                    f"rules do not describe a supported game; "
                    f"unknown text: {rules_text[:80]!r}"
                ],
                assumptions=[],
                unsupported_mechanics=["free-form natural language"],
            )
        from .test_ir_games import KUHNISH  # local import keeps module light

        return dict(KUHNISH), DraftReport(
            ambiguities=["tie-breaking order assumed alphabetical by seat"],
            assumptions=[self._KNOWN],
            unsupported_mechanics=[],
        )


# ---------------------------------------------------------------------------
# Deterministic verification gates
# ---------------------------------------------------------------------------


def _semantic_smoke(doc: dict[str, Any], episodes: int = 30) -> dict[str, Any]:
    """Random-simulation smoke over the generic interpreter (§12 subset)."""
    from .gamespec_runtime import IRGame

    game = IRGame(doc)
    state = game.new_initial_state()
    rng = 987654321

    def rnd() -> float:
        nonlocal rng
        rng = (1103515245 * rng + 12345) % (2**31)
        return rng / (2**31)

    terminals = illegal = 0
    for _ in range(episodes):
        s = game.new_initial_state()
        steps = 0
        while not s.is_terminal() and steps < 500:
            steps += 1
            if s.is_chance_node():
                outcomes, probs = zip(*s.chance_outcomes())
                r, acc, choice = rnd(), 0.0, outcomes[-1]
                for o, p in zip(outcomes, probs):
                    acc += p
                    if r <= acc:
                        choice = o
                        break
                s.apply_action(choice)
            else:
                legal = list(s.legal_actions(s.current_player()))
                if not legal:
                    break
                s.apply_action(legal[int(rnd() * len(legal)) % len(legal)])
        if s.is_terminal():
            terminals += 1
            rets = s.returns()
            assert all(abs(r) < 10**6 for r in rets), "non-finite returns"
        else:
            illegal += 1  # hit the step cap: possible no-progress loop
    return {"episodes": episodes, "reached_terminal": terminals,
            "step_cap_hits": illegal}


@dataclass
class CompiledGame:
    definition: GameDefinition
    report: DraftReport
    smoke: dict[str, Any]
    spec_hash: str


@dataclass
class CompileFailure:
    rules_text_head: str
    stage: str          # 'static' | 'semantic' | 'compiler'
    diagnostics: list[str]


def compile_and_verify(
    llm: RuleCompilerLLM,
    rules_text: str,
    family_id: str | None = None,
    smoke_episodes: int = 30,
) -> CompiledGame | CompileFailure:
    """Full §13 gate chain. Accepts only specs that pass every stage."""
    t0 = time.time()
    try:
        draft, report = llm.compile(rules_text)
    except Exception as e:  # compiler crashed — that's a failure, not a spec
        return CompileFailure(rules_text[:120], "compiler", [f"{type(e).__name__}: {e}"])

    if not draft:
        return CompileFailure(
            rules_text[:120], "compiler",
            ["no draft produced"] + report.ambiguities,
        )

    # Stage 1 — static validation (§11).
    try:
        doc = load_ir(dict(draft))
    except IRValidationError as e:
        return CompileFailure(rules_text[:120], "static", [str(e)])

    # Stage 2 — semantic smoke (§12): must actually play.
    try:
        smoke = _semantic_smoke(doc, episodes=smoke_episodes)
    except Exception as e:
        return CompileFailure(rules_text[:120], "semantic", [f"{type(e).__name__}: {e}"])
    if smoke["reached_terminal"] == 0:
        return CompileFailure(
            rules_text[:120], "semantic",
            [f"no episode reached terminal in {smoke_episodes} random episodes"],
        )

    fam = family_id or f"compiled-{ir_hash(doc)[:12]}"
    defn = GameDefinition(
        family_id=fam,
        spec=dict(draft),
        rules_text=rules_text.strip(),
        split=assign_split(fam),
        benchmark={"smoke": smoke, "compile_seconds": round(time.time() - t0, 3)},
    )
    return CompiledGame(defn, report, smoke, ir_hash(doc))
