"""CPU tests for the RuleZero evaluation harness (no LLM endpoint needed).

Run:  .venv/bin/python -m pytest rulezero/ -q   (or python3 rulezero/test_eval.py)
"""

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from rulezero.agents import RandomAgent  # noqa: E402
from rulezero.evaluate import evaluate_candidate, play_episode  # noqa: E402
from rulezero.recorder import EpisodeRecorder, append_jsonl  # noqa: E402
from rulezero.rules_registry import rules_hash, rules_text  # noqa: E402
from rulezero.serialize import describe_game  # noqa: E402


def _mk(seat_salt):
    def factory(eps: int, seat: int):
        return RandomAgent(random.Random((eps * 1000003 + seat * 7919 + seat_salt) & 0xFFFFFFFF))
    return factory

def _run(game_id, episodes=4, seeds=(11, 12, 13, 14)):
    return evaluate_candidate(
        game_id,
        opponent_factory=_mk(13),
        candidate_factory=_mk(7),
        seeds=seeds[:episodes],
    )


def test_random_vs_random_is_near_zero_on_kuhn():
    s = _run("kuhn_poker", episodes=30)
    assert abs(s["meanReturn"]) < 0.5, f"random-vs-random drifted: {s['meanReturn']}"


def test_seat_rotation_covers_every_seat():
    s = _run("kuhn_poker", episodes=6)
    assert set(s["returnBySeat"].keys()) == {"p0", "p1"}
    assert s["episodes"] == 8  # 4 default seeds x 2 seats


def test_determinism_same_seeds_same_summary():
    a = _run("kuhn_poker")
    b = _run("kuhn_poker")
    assert a == b


def test_rules_registry_hash_is_stable_and_textual():
    for gid in ("kuhn_poker", "leduc_poker", "goofspiel", "liars_dice"):
        t = rules_text(gid)
        assert len(t) > 100, f"{gid} rules too thin"
        assert rules_hash(gid) == rules_hash(gid)


def test_trajectory_jsonl_roundtrip(tmp_path=None):
    import pyspiel

    game = pyspiel.load_game("kuhn_poker")
    desc = describe_game(game)
    rec = EpisodeRecorder(desc, 5, [{"name": "random"}, {"name": "random"}])
    rets, failures = play_episode(
        game, 5,
        [RandomAgent(random.Random(1)), RandomAgent(random.Random(2))],
        0, rec, random.Random(3),
    )
    record = rec.finish(rets)
    assert record["schemaVersion"] == 2
    assert record["result"]["winnerIds"]
    out = Path(tmp_path or "/tmp") / "rz-test.jsonl"
    append_jsonl(out, record)
    loaded = json.loads(out.read_text().splitlines()[0])
    assert loaded["episodeId"] == record["episodeId"]
    assert all(st["proposalWasLegal"] for st in loaded["steps"])
    if tmp_path:
        out.unlink()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"PASS {name}")
    print("all eval tests passed")
