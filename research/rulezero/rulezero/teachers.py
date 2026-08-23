"""OpenSpiel teacher wrappers (Phase 9/18) — thin, no reimplementation.

Teachers provide strategic supervision for datasets: per-decision policy
probabilities and a recommended action, plus solution-quality metrics so we
KNOW how strong a teacher is before trusting its labels. All heavy lifting
(CFR solvers, exploitability) is OpenSpiel's; this module only adapts them to
the RuleZero Agent/evaluator interfaces.
"""

from __future__ import annotations


class Teacher:
    """policy(game, state, player) -> {action_id: prob}."""

    name = "teacher"

    def policy(self, game, state, player: int) -> dict[int, float]:
        raise NotImplementedError

    def quality(self) -> dict:
        return {}


class CFRTeacher(Teacher):
    """CFR-trained tabular teacher for small zero-sum games (Kuhn/Leduc)."""

    def __init__(self, game_id: str = "kuhn_poker", iterations: int = 400, plus: bool = False):
        import pyspiel
        from open_spiel.python.algorithms import cfr

        self.game = pyspiel.load_game(game_id)
        self.solver = cfr.CFRPlusSolver(self.game) if plus else cfr.CFRSolver(self.game)
        for _ in range(iterations):
            self.solver.evaluate_and_update_policy()
        self._policy = self.solver.average_policy()
        self.iterations = iterations
        self.plus = plus
        self.name = f"cfr{'plus' if plus else ''}-{iterations}it"

    def policy(self, game, state, player: int) -> dict[int, float]:
        legal = state.legal_actions(player)
        probs = self._policy.action_probabilities(state, player)
        total = sum(probs.get(a, 0.0) for a in legal)
        if total <= 0:
            u = 1.0 / len(legal)
            return {a: u for a in legal}
        return {a: probs.get(a, 0.0) / total for a in legal}

    def quality(self) -> dict:
        from open_spiel.python.algorithms import exploitability

        return {
            "nashConv": round(float(exploitability.nash_conv(self.game, self._policy)), 6),
            "exploitability": round(float(exploitability.exploitability(self.game, self._policy)), 6),
            "iterations": self.iterations,
            "algorithm": "CFRPlus" if self.plus else "CFR",
            "source": "open_spiel.python.algorithms.cfr",
        }


class RandomTeacher(Teacher):
    """Uniform teacher — sanity baseline for the labelling pipeline."""

    def __init__(self, game_id: str):
        import pyspiel

        self.game = pyspiel.load_game(game_id)
        self.name = "random"

    def policy(self, game, state, player: int) -> dict[int, float]:
        legal = state.legal_actions(player)
        u = 1.0 / len(legal)
        return {a: u for a in legal}

    def quality(self) -> dict:
        from open_spiel.python import policy as policy_lib
        from open_spiel.python.algorithms import exploitability

        uni = policy_lib.UniformRandomPolicy(self.game)
        return {"exploitability": round(float(exploitability.exploitability(self.game, uni)), 6)}
