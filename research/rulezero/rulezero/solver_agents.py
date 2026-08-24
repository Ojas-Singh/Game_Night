"""CPU solver agents (Phase 3A §9-§11): capability-aware AI seats for any
GameSpec game, plus a reusable policy cache keyed by
(specHash, algorithm, iterations, solverVersion).

OpenSpiel does the solving — IRGame *is* an OpenSpiel game. No CFR is
rewritten here; we only adapt tabular policies to absolute env action ids
and cache them.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

from .gamespec_ir import ir_hash
from .gamespec_runtime import IRGame

SOLVER_VERSION = 2  # bump when information_state_string format changes

# ---------------------------------------------------------------------------
# Policy cache (§11)
# ---------------------------------------------------------------------------


class PolicyCache:
    """File-backed cache of solved tabular policies.

    Layout: <root>/<specHash[:16]>/cfr-i<iters>-v<version>.json
    Policies are stored as {infoState: {envActionId: prob}} so they survive
    interpreter refactors as long as info strings stay stable.
    """

    def __init__(self, root: str | Path | None = None) -> None:
        self.root = Path(root or os.environ.get(
            "RULEZERO_POLICY_CACHE",
            Path(__file__).resolve().parent.parent / "cache" / "policies"))

    def _path(self, spec_hash: str, algorithm: str, iters: int) -> Path:
        d = self.root / spec_hash[:16]
        return d / f"{algorithm}-i{iters}-v{SOLVER_VERSION}.json"

    def load(self, spec_hash: str, algorithm: str,
             iters: int) -> tuple[dict[str, dict[int, float]], dict] | None:
        """Returns (policy, meta); None is a miss. Empty policy = miss."""
        p = self._path(spec_hash, algorithm, iters)
        if not p.exists():
            return None
        raw = json.loads(p.read_text())
        pol = {k: {int(a): pr for a, pr in v.items()}
               for k, v in raw["policy"].items()}
        if not pol:
            return None
        return pol, raw.get("meta", {})

    def store(self, spec_hash: str, algorithm: str, iters: int,
              policy: dict[str, dict[int, float]],
              meta: dict[str, Any]) -> str:
        p = self._path(spec_hash, algorithm, iters)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        payload = {
            "schemaVersion": 1,
            "specHash": spec_hash,
            "algorithm": algorithm,
            "iterations": iters,
            "solverVersion": SOLVER_VERSION,
            "meta": meta,
            # int keys -> strings for JSON
            "policy": {k: {str(a): pr for a, pr in v.items()}
                       for k, v in policy.items()},
        }
        tmp.write_text(json.dumps(payload, sort_keys=True))
        os.replace(tmp, p)
        return hashlib.sha256(p.read_bytes()).hexdigest()[:16]


_CACHE = PolicyCache()

# ---------------------------------------------------------------------------
# Solving (§21)
# ---------------------------------------------------------------------------


def _remember_legals(spec: dict[str, Any]) -> dict[str, list[int]]:
    """Walk the tree recording infoState -> sorted legal action ids."""
    legals: dict[str, list[int]] = {}
    game = IRGame(spec)
    stack = [game.new_initial_state()]
    while stack:
        s = stack.pop()
        if s.is_terminal():
            continue
        if s.is_chance_node():
            for a, _ in s.chance_outcomes():
                stack.append(s.child(a))
            continue
        p = s.current_player()
        key = s.information_state_string(p)
        la = sorted(s.legal_actions(p))
        if key not in legals or len(la) > len(legals[key]):
            legals[key] = la
        for a in la:
            stack.append(s.child(a))
    return legals


def solve_game_cfr(
    spec: dict[str, Any],
    iterations: int = 300,
    use_cache: bool = True,
) -> dict[str, Any]:
    """Solve a small 2p zero-sum GameSpec game with OpenSpiel CFR.

    Returns {policy, nashConv, iterations, solveSeconds, cached, states}
    where policy maps infoState -> {absoluteEnvActionId: prob}.
    """
    from open_spiel.python.algorithms import cfr as osp_cfr
    from open_spiel.python.algorithms import exploitability

    h = ir_hash(spec)
    iterations = max(1, min(int(iterations), 20_000))
    if use_cache:
        hit = _CACHE.load(h, "cfr", iterations)
        if hit is not None:
            pol, meta = hit
            return {"policy": pol, "nashConv": meta.get("nashConv"),
                    "cached": True, "iterations": iterations,
                    "states": len(pol), "solveSeconds": 0.0}

    t0 = time.time()
    game = IRGame(spec)
    solver = osp_cfr.CFRSolver(game)
    for _ in range(iterations):
        solver.evaluate_and_update_policy()
    avg = solver.average_policy()
    try:
        nc = float(exploitability.nash_conv(game, avg))
    except Exception:  # noqa: BLE001 — quality metric is best-effort
        nc = None

    # TabularPolicy rows are full-width masks over absolute env action ids.
    legals = _remember_legals(spec)
    policy: dict[str, dict[int, float]] = {}
    for key, idx in avg.state_lookup.items():
        row = avg.action_probability_array[idx]
        la = legals.get(key)
        if not la:
            continue
        policy[key] = {a: float(row[a]) for a in la if a < len(row)}

    out = {
        "policy": policy,
        "nashConv": nc,
        "iterations": iterations,
        "cached": False,
        "states": len(policy),
        "solveSeconds": round(time.time() - t0, 3),
    }
    if policy:  # never persist empty extractions
        _CACHE.store(h, "cfr", iterations, policy,
                     {"nashConv": nc, "gameName": spec.get("name")})
    return out


# ---------------------------------------------------------------------------
# Agents (§9/§10)
# ---------------------------------------------------------------------------


class CFRAgent:
    """Acts greedily w.r.t. a solved CFR average policy."""

    kind = "cfr"

    def __init__(self, spec: dict[str, Any], iterations: int = 300) -> None:
        self.legals = _remember_legals(spec)
        sol = solve_game_cfr(spec, iterations)
        self.policy = sol["policy"]
        self.meta = {k: v for k, v in sol.items() if k != "policy"}

    def act(self, info_state: str, env_actions: list[int]) -> int:
        row = self.policy.get(info_state)
        if not row:
            # Unseen info state: fall back to middle candidate deterministically.
            return env_actions[len(env_actions) // 2]
        best, best_p = env_actions[0], -1.0
        for a in env_actions:
            p = float(row.get(a, 0.0))
            if p > best_p:
                best, best_p = a, p
        return best

    def probs_for(self, info_state: str) -> tuple[list[int], list[float]]:
        """(envActions, probs) for the strategy inspector (§13).

        Only ever computed from an information state string — never from
        another seat's hidden zones.
        """
        row = self.policy.get(info_state)
        if not row:
            return [], []
        legal = sorted(int(k) for k in row)
        ps = [float(row[a]) for a in legal]
        total = sum(ps) or 1.0
        return legal, [p / total for p in ps]


def choose_agent_for_game(spec: dict[str, Any]) -> str:
    """Capability-aware default AI (§10). Conservative on purpose:
    small 2p games with few branches get CFR; everything else random.
    """
    n = int(spec["players"]["count"])
    if n != 2:
        return "random"
    max_branches = 0
    for ph in spec["phases"]:
        dec = ph.get("decision")
        if dec:
            max_branches = max(max_branches, len(dec["actions"]))
    return "cfr" if max_branches <= 8 else "random"


AGENT_LABELS = {
    "random": "Random",
    "first": "First-always",
    "cfr": "CFR Solver",
}
