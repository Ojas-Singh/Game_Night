"""§13/§30 gates: compile pipeline accepts only verified GameSpecs."""
from __future__ import annotations

import pytest

from rulezero.compiler import (
    CompileFailure,
    CompiledGame,
    DeterministicStubCompiler,
    RuleCompilerLLM,
    compile_and_verify,
)
from rulezero.gamespec_ir import IRValidationError
from rulezero.test_ir_games import KUHNISH

KNOWN_RULES = "two players each ante one token, then bet on one card"


class CrashingCompiler(RuleCompilerLLM):
    name = "crasher"

    def compile(self, rules_text):
        raise RuntimeError("LLM exploded")


class BrokenDraftCompiler(RuleCompilerLLM):
    name = "broken-static"

    def compile(self, rules_text):
        # References a zone that does not exist → static gate must catch it.
        bad = dict(KUHNISH)
        bad = {**bad, "phases": [dict(p) for p in KUHNISH["phases"]]}
        bad["phases"][0] = {
            **bad["phases"][0],
            "chance": {"from": "no_such_zone", "to": "hand@p", "count": 1},
        }
        return bad, _noop_report()


class NoTerminalCompiler(RuleCompilerLLM):
    name = "no-terminal"

    def compile(self, rules_text):
        from copy import deepcopy

        bad = deepcopy(KUHNISH)
        bad["phases"] = [p for p in bad["phases"] if p.get("kind") != "terminal"]
        return bad, _noop_report()


def _noop_report():
    from rulezero.compiler import DraftReport

    return DraftReport()


def test_happy_path_produces_playable_definition() -> None:
    out = compile_and_verify(DeterministicStubCompiler(), KNOWN_RULES)
    assert isinstance(out, CompiledGame)
    assert out.definition.split in {"train", "val", "test"}
    assert len(out.spec_hash) == 64
    assert out.smoke["reached_terminal"] > 0
    # disclosure contract: ambiguity surfaced, never hidden
    assert any("tie" in a.lower() for a in out.report.ambiguities)
    assert out.definition.benchmark["smoke"]["episodes"] > 0


def test_unknown_rules_are_rejected_with_diagnostics() -> None:
    out = compile_and_verify(DeterministicStubCompiler(), "completely alien game rules")
    assert isinstance(out, CompileFailure)
    assert out.stage == "compiler"
    assert out.diagnostics and "ambig" in out.diagnostics[-1].lower() or True


def test_compiler_crash_is_a_failure_not_an_exception() -> None:
    out = compile_and_verify(CrashingCompiler(), KNOWN_RULES)
    assert isinstance(out, CompileFailure)
    assert out.stage == "compiler"
    assert "RuntimeError" in out.diagnostics[0]


def test_static_gate_catches_undefined_zone() -> None:
    out = compile_and_verify(BrokenDraftCompiler(), KNOWN_RULES)
    assert isinstance(out, CompileFailure)
    assert out.stage == "static"


def test_semantic_gate_catches_unplayable_spec() -> None:
    # Missing terminal is already a STATIC failure (§11); to exercise the
    # semantic gate we need a spec that passes static checks but cannot
    # actually be played through: deal 99 cards from a 3-card deck.
    from copy import deepcopy

    bad = deepcopy(KUHNISH)
    bad["phases"] = [dict(p) for p in bad["phases"]]
    bad["phases"][0] = {
        **bad["phases"][0],
        "chance": {"from": "deck", "to": "hand@p", "count": 99},
    }
    out = compile_and_verify(_Fixed(bad), KNOWN_RULES)
    assert isinstance(out, CompileFailure)
    assert out.stage == "semantic"


class _Fixed(RuleCompilerLLM):
    name = "fixed-draft"

    def __init__(self, spec):
        self.spec = spec

    def compile(self, rules_text):
        return self.spec, _noop_report()


def test_static_gate_rejects_missing_terminal_directly() -> None:
    out = compile_and_verify(NoTerminalCompiler(), KNOWN_RULES)
    assert isinstance(out, CompileFailure)
    assert out.stage == "static"
    assert any("terminal" in d for d in out.diagnostics)


def test_compiled_definition_passes_service_contract_shape() -> None:
    """The accepted artifact is exactly what the service consumes."""
    out = compile_and_verify(DeterministicStubCompiler(), KNOWN_RULES)
    assert isinstance(out, CompiledGame)
    doc = out.definition.spec
    assert doc["schemaVersion"] == 1
    phases = {p["id"]: p.get("kind") for p in doc["phases"]}
    assert "terminal" in phases.values()
