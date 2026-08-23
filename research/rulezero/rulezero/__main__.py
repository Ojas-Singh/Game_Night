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
from .agents import TeacherAgent
from .teachers import CFRTeacher

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
    elif candidate in ("llm", "llm-think"):
        assert model and base_url, "--model and --url required for llm candidate"
        think = candidate == "llm-think"
        summary = evaluate_candidate(
            game_id,
            opponent_factory=lambda eps, seat: RandomAgent(random.Random(eps * 1000003 + seat * 7919 + 13)),
            candidate_factory=lambda eps, seat: OpenAIAgent(
                base_url,
                model,
                no_think=not think,
                max_tokens=(3500 if think else 500),
                timeout_s=(600.0 if think else 60.0),
                name_suffix=("-think" if think else ""),
            ),
            seeds=seeds,
            out_jsonl=jsonl,
        )
    elif candidate == "cfr":
        summary = evaluate_candidate(
            game_id,
            opponent_factory=lambda eps, seat: RandomAgent(random.Random(eps * 1000003 + seat * 7919 + 13)),
            candidate_factory=lambda eps, seat: TeacherAgent(CFRTeacher(game_id)),
            seeds=seeds,
            out_jsonl=jsonl,
        )
    elif candidate == "llm-vs-cfr":
        summary = evaluate_candidate(
            game_id,
            opponent_factory=lambda eps, seat: TeacherAgent(CFRTeacher(game_id)),
            candidate_factory=lambda eps, seat: OpenAIAgent(base_url, model),
            seeds=seeds,
            out_jsonl=jsonl,
        )
    else:
        raise SystemExit(f"unknown candidate {candidate!r} (random|llm|cfr|llm-vs-cfr)")

    print(json.dumps(summary, indent=2))
    return summary


def main():
    ap = argparse.ArgumentParser(prog="rulezero.benchmark")
    sub = ap.add_subparsers(dest="cmd", required=True)

    insp = sub.add_parser("inspect")
    insp.add_argument("--game", required=True)

    lab = sub.add_parser("label")
    lab.add_argument("--game", required=True)
    lab.add_argument("--episodes", type=int, default=50)
    lab.add_argument("--iterations", type=int, default=400)
    lab.add_argument("--out")
    lab.add_argument("--report", action="store_true", help="print teacher quality metrics")

    bench = sub.add_parser("run")
    bench.add_argument("--game", required=True)
    bench.add_argument("--episodes", type=int, default=20)
    bench.add_argument("--candidate", default="random")
    bench.add_argument("--url")
    bench.add_argument("--model")

    args = ap.parse_args()
    if args.cmd == "inspect":
        inspect_game(args.game)
        return

    if args.cmd == "label":
        import random as _r
        from pathlib import Path as _P
        from .recorder import EpisodeRecorder, append_jsonl
        from .evaluate import play_episode

        game = pyspiel.load_game(args.game)
        desc = describe_game(game)
        teacher = CFRTeacher(args.game, iterations=args.iterations)
        out = _P(args.out) if args.out else ARTIFACTS.parents[1] / "artifacts" / "datasets" / "labelled" / f"{args.game}-{teacher.name}.jsonl"
        seeds = [9000 + i for i in range(args.episodes)]
        n_steps = 0
        for eps in seeds:
            agents = [RandomAgent(_r.Random(eps * 1000003 + s * 31 + 5)) for s in range(game.num_players())]
            rec = EpisodeRecorder(desc, eps, [{"name": a.name} for a in agents])
            rets, _ = play_episode(game, eps, agents, 0, rec, _r.Random(eps), teacher=teacher)
            append_jsonl(out, rec.finish(rets))
            n_steps += len(rec.record["steps"])
        q = teacher.quality()
        print(json.dumps({"out": str(out), "episodes": len(seeds), "labelledSteps": n_steps, "teacherQuality": q}, indent=2))
        if args.report:
            REPORTS.mkdir(parents=True, exist_ok=True)
            (REPORTS / "teacher_quality.json").write_text(json.dumps(q, indent=2))
        return

    benchmark(args.game, args.episodes, args.candidate, args.url, args.model)


if __name__ == "__main__":
    main()
