"""Seat-rotating strict evaluation runner (Phases 7 + 13).

For each seed, the CANDIDATE plays every seat in turn (opponents fill the
rest). Raw statistics are primary: return mean/CI, win rate, by-seat splits,
strict metrics (parse/legal rates). ELO is not used here.
"""

from __future__ import annotations

import hashlib
import json
import random
import statistics
from dataclasses import dataclass, field
from pathlib import Path

import pyspiel

from .agents import Agent, StrictFailure
from .recorder import EpisodeRecorder, append_jsonl
from .serialize import describe_game, information_state


def _seeded_rng(seed: int, salt: int):
    return random.Random(seed * 1_000_003 + salt)


def _obs_hash(game, state, seat: int) -> str:
    return hashlib.sha1(information_state(game, state, seat).encode()).hexdigest()


@dataclass
class CandidateReport:
    game_id: str
    candidate: str
    episodes: int = 0
    returns_by_seat: dict = field(default_factory=dict)
    all_returns: list = field(default_factory=list)
    wins: int = 0
    strict_failures: int = 0
    extra: dict = field(default_factory=dict)

    def add(self, seat: int, seats: int, ret: float):
        self.episodes += 1
        self.all_returns.append(ret)
        self.returns_by_seat.setdefault(f"p{seat}", []).append(ret)
        if seats == 2 and ret > 0:
            self.wins += 1

    def summary(self) -> dict:
        rets = self.all_returns or [0.0]
        mean = statistics.mean(rets)
        ci95 = 1.96 * statistics.stdev(rets) / (len(rets) ** 0.5) if len(rets) > 1 else 0.0
        return {
            "gameId": self.game_id,
            "candidate": self.candidate,
            "episodes": self.episodes,
            "meanReturn": round(mean, 4),
            "ci95": round(ci95, 4),
            "winRate2p": round(self.wins / max(1, sum(1 for r in rets if r != 0)), 4) if self.all_returns else None,
            "returnBySeat": {
                k: round(statistics.mean(v), 4) for k, v in sorted(self.returns_by_seat.items())
            },
            "strictFailures": self.strict_failures,
            **self.extra,
        }


def play_episode(game, seed: int, agents: list[Agent], candidate_seat: int,
                 recorder: EpisodeRecorder | None, rng) -> tuple[list[float], int]:
    """Play one episode; returns (returns, strict_failure_count)."""
    state = game.new_initial_state()
    failures = 0
    step = 0
    while not state.is_terminal():
        if state.is_chance_node():
            outcomes = state.chance_outcomes()
            aids, probs = zip(*outcomes)
            aid = rng.choices(aids, weights=probs)[0]
            state.apply_action(int(aid))
            continue
        seat = state.current_player()
        agent = agents[seat]
        ohash = _obs_hash(game, state, seat)
        try:
            t0 = _now()
            aid = agent.act(game, state, seat)
            lat = _since(t0)
            if recorder and seat == candidate_seat:
                recorder.step(step, seat, agent.name, aid,
                              state.action_to_string(seat, aid), ohash, latency_ms=lat)
            elif recorder:
                recorder.step(step, seat, agent.name, aid,
                              state.action_to_string(seat, aid), ohash)
            state.apply_action(aid)
        except StrictFailure as e:
            failures += 1
            if recorder:
                recorder.step_failed(step, seat, agent.name, str(e), ohash)
            # Neutral substitution so the episode completes; the failure is
            # already recorded verbatim against the model.
            legal = state.legal_actions(seat)
            state.apply_action(rng.choice(legal))
        step += 1
    return [state.returns()[i] for i in range(game.num_players())], failures


def _now():
    import time

    return time.monotonic()


def _since(t0):
    import time

    return int((time.monotonic() - t0) * 1000)


def evaluate_candidate(
    game_id: str,
    opponent_factory,
    candidate_factory,
    seeds: list[int],
    *,
    out_jsonl: Path | None = None,
    record_all_seats: bool = False,
) -> dict:
    """Rotate the candidate through every seat for every seed.

    Factories receive (episode_seed, seat) and must derive every internal
    random stream from BOTH (never a constant, never seed-only): two fixed
    seed-only agents become observation-blind 'scripts' whose interaction can
    be systematically seat-asymmetric — we measured random-vs-random Kuhn at
    -0.625/episode that way. With (seed, seat) streams the candidate and its
    opponents are exchangeable under rotation, so E[return] == 0 exactly.
    """
    game = pyspiel.load_game(game_id)
    desc = describe_game(game)
    report = CandidateReport(game_id=game_id, candidate=candidate_factory(seeds[0], 0).name)
    llm_metrics: dict | None = None

    for i, seed in enumerate(seeds):
        for seat in range(game.num_players()):
            cand = candidate_factory(seed, seat)
            agents: list[Agent] = [
                cand if s == seat else opponent_factory(seed, s) for s in range(game.num_players())
            ]
            rng = _seeded_rng(seed, seat)
            recorder = (
                EpisodeRecorder(desc, seed, [{"name": a.name} for a in agents])
                if out_jsonl and (record_all_seats or seat == 0)
                else None
            )
            returns, failures = play_episode(game, seed, agents, seat, recorder, rng)
            report.add(seat, game.num_players(), returns[seat])
            report.strict_failures += failures
            m = getattr(cand, "metrics", None)
            if callable(m):
                llm_metrics = m()
            if recorder is not None:
                append_jsonl(out_jsonl, recorder.finish(returns))

    summary = report.summary()
    if llm_metrics:
        summary["model"] = llm_metrics
    return summary
