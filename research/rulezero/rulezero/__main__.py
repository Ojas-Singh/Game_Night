"""CLI entry points (Phase 35): inspect_game and benchmark.

  python -m rulezero.inspect_game --game kuhn_poker
  python -m rulezero.benchmark --game kuhn_poker --episodes 20 --candidate random
"""

import argparse
import json
import random
from pathlib import Path

import pyspiel

from .agents import OpenAIAgent, RandomAgent
from .evaluate import evaluate_candidate
from .rules_registry import RULES
from .serialize import describe_game

REPO = Path(__file__).resolve().parents[3]  # Game_Night/
ARTIFACTS = REPO / "artifacts" / "evaluations"
REPORTS = Path(__file__).resolve().parent.parent / "reports"


def inspect_game(game_id: str) -> dict:
    game = pyspiel.load_game(game_id)
    desc = describe_game(game)
    state = game.new_initial_state()
    print(json.dumps(desc, indent=2))
    print(f"initial legal actions: {state.legal_actions(0)}")
    print(f"registered rules: {'yes' if game_id in RULES else 'GENERIC FALLBACK'}")
    return desc


def benchmark(game_id: str, episodes: int, candidate: str, base_url: str | None, model: str | None,
              seed0: int = 1000, out: str | None = None) -> dict:
    seeds = [seed0 + i for i in range(episodes)]
    jsonl = ARTIFACTS / "week1" / f"{game_id}-{candidate}-seats.jsonl" if out is None else Path(out)

    if candidate == "random":
        summary = evaluate_candidate(
            game_id,
            opponent_factory=lambda eps, seat: RandomAgent(random.Random(eps * 1000003 + seat * 7919 + 13)),
            candidate_factory=lambda eps, seat: RandomAgent(random.Random(eps * 1000003 + seat * 104729 + 7)),
            seeds=seeds,
            out_jsonl=jsonl,
        )
    elif candidate == "llm":
        assert model and base_url, "--model and --url required for llm candidate"
        summary = evaluate_candidate(
            game_id,
            opponent_factory=lambda eps, seat: RandomAgent(random.Random(eps * 1000003 + seat * 7919 + 13)),
            candidate_factory=lambda eps, seat: OpenAIAgent(base_url, model),
            seeds=seeds,
            out_jsonl=jsonl,
        )
    else:
        raise SystemExit(f"unknown candidate {candidate!r} (random|llm)")

    print(json.dumps(summary, indent=2))
    return summary


def main():
    ap = argparse.ArgumentParser(prog="rulezero.benchmark")
    sub = ap.add_subparsers(dest="cmd", required=True)

    insp = sub.add_parser("inspect")
    insp.add_argument("--game", required=True)

    bench = sub.add_parser("run")
    bench.add_argument("--game", required=True)
    bench.add_argument("--episodes", type=int, default=20)
    bench.add_argument("--candidate", default="random")
    bench.add_argument("--url")
    bench.add_argument("--model")

    args = ap.parse_args()
    if args.cmd == "inspect":
        inspect_game(args.game)
    else:
        benchmark(args.game, args.episodes, args.candidate, args.url, args.model)


if __name__ == "__main__":
    main()
