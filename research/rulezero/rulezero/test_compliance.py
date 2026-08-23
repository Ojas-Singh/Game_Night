"""Compliance-suite entry points (Phase-2 §12)."""

from __future__ import annotations

import sys

try:
    from rulezero.cabo_env import CaboGame
    from rulezero.compliance import run_compliance
except ImportError:  # direct script execution
    from cabo_env import CaboGame
    from compliance import run_compliance


def _cabo_privacy_checker():
    from cabo_env import card_label

    def check(st, player: int) -> str | None:
        allowed = {card_label(c) for c in st.knowledge[player]}
        if st.discard:
            allowed.add(card_label(st.discard[-1]))
        if (st.phase == "DRAW_DECISION" and st.drawn_card is not None
                and player == st.current_turn):
            allowed.add(card_label(st.drawn_card))
        if st.is_terminal():
            allowed = None  # everything public at reveal time
        obs = st.observation_string(player)
        import re
        labels = set(re.findall(r"\b(?:[2-9KQAJ]|10)[SHDC]\b", obs))
        if st.is_terminal():
            return None
        leaked = {x for x in labels if x not in allowed and allowed is not None}
        if leaked:
            return f"leaked={leaked} obs={obs!r}"
        return None

    return check


def main() -> int:
    failures_all: dict[str, list[str]] = {}
    for n in (2, 4, 6):
        game = CaboGame({"seed": 1, "players": n})
        fails = run_compliance(game, episodes=10,
                               obs_privacy=_cabo_privacy_checker())
        failures_all[f"cabo_research({n}p)"] = fails
    ok = True
    for name, fails in failures_all.items():
        status = "PASS" if not fails else "FAIL"
        print(f"{status} compliance {name}")
        for msg in fails[:8]:
            print(f"   - {msg}")
        ok = ok and not fails
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())


def test_gamespec_specduel_passes_compliance():
    """§32 acceptance: a GameSpec game is accepted only via compliance."""
    from rulezero.gamespec_compile import register_gamespec
    from rulezero.compliance import run_compliance

    game, digest, _rules = register_gamespec({
        "name": "specduel",
        "ante": 1,
        "deck": {"ranks": [2, 3, 4, 5, 6, 7, 8, 9, 10], "copiesPerRank": 1},
        "firstDecision": {"actor": "first", "raiseAmount": 1},
        "secondDecision": {"actor": "second", "raiseAmount": 1},
    })
    assert len(digest) == 64  # SHA-256
    fails = run_compliance(game, episodes=20)
    assert not fails, fails[:6]
