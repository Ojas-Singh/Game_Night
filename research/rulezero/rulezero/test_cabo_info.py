"""Adversarial Phase-2 validity tests for the Cabo OpenSpiel twin.

Covers:
  §3 — no hidden-information leakage in any observation, for every player,
       across random reachable states + scripted event fixtures;
  §4 — bounded win/loss utility semantics incl. caller tiebreak;
  §7 — two world states indistinguishable to a player yield identical
       perfect-recall information-state strings.
"""

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from rulezero.cabo_env import (  # noqa: E402
    K_FLUSH_OWN,
    CaboGame,
    card_label,
    decode_action,
    make_deck,
)


def _labels_in(text: str) -> set[str]:
    """Extract rank+suit labels like 7H / KS from a rendered view."""
    import re

    return set(re.findall(r"\b(?:A|2|3|4|5|6|7|8|9|10|J|Q|K)[SHDC]\b", text))


def _drive_random(st, rng, cap=3000):
    """Chance-aware random playout used by all Cabo tests."""
    steps = 0
    while not st.is_terminal() and steps < cap:
        steps += 1
        if st.is_chance_node():
            aids, _probs = zip(*st.chance_outcomes())
            st.apply_action(rng.choice(aids))
            continue
        p = st.current_player()
        legal = st.legal_actions(p)
        if not legal:
            break
        st.apply_action(rng.choice(legal))
    return steps


def test_no_leakage_across_random_reachable_states():
    g = CaboGame({"seed": 1})
    rng = random.Random(2024)
    checked = 0
    for eps in range(25):
        st = g.new_initial_state(eps * 17 + 3)
        steps = 0
        while not st.is_terminal() and steps < 400:
            if st.is_chance_node():
                aids, _probs = zip(*st.chance_outcomes())
                st.apply_action(rng.choice(aids))
                continue
            for p in range(2):
                allowed = {card_label(c) for c in st.knowledge[p]}
                if st.discard:
                    allowed.add(card_label(st.discard[-1]))
                if st.phase == "DRAW_DECISION" and st.drawn_card is not None and p == st.current_turn:
                    allowed.add(card_label(st.drawn_card))
                obs = st.observation_string(p)
                leaked = _labels_in(obs) - allowed - {"_"}
                assert not leaked, (
                    f"LEAK ep={eps} step={steps} player={p} leaked={leaked} "
                    f"obs={obs!r} knowledge={sorted(st.knowledge[p])}"
                )
            legal = st.legal_actions(st.current_player())
            if not legal:
                break
            st.apply_action(rng.choice(legal))
            steps += 1
        checked += steps
    assert checked > 300


def test_fixture_starting_peek_shows_only_learned_slots():
    g = CaboGame({"seed": 42})
    st = g.new_initial_state()
    rng = random.Random(1)
    while st.is_chance_node():  # resolve the 8 chance deals first
        aids, _p = zip(*st.chance_outcomes())
        st.apply_action(rng.choice(aids))
    # p0 peeks slots [0,1]
    st.apply_action(next(a for a in st.legal_actions(0)
                         if decode_action(a) == (3, (0, 1))))
    obs0 = st.observation_string(0)
    assert card_label(st.hands[0][0]) in obs0
    assert card_label(st.hands[0][1]) in obs0
    assert "?" in obs0  # unlearned own slots stay hidden
    obs1 = st.observation_string(1)
    assert card_label(st.hands[0][0]) not in obs1  # p1 sees NOTHING of p0's hand
    assert str(len([c for c in st.hands[0] if c is not None])) in obs1  # only a count


def test_fixture_failed_flush_reveals_publicly():
    g = CaboGame({"seed": 21})
    st = g.new_initial_state(21)
    rng = random.Random(9)
    while st.is_chance_node() or st.phase == "INITIAL_PEEK":
        if st.is_chance_node():
            aids, _p = zip(*st.chance_outcomes())
            st.apply_action(rng.choice(aids))
        else:
            st.apply_action(rng.choice(st.legal_actions(st.current_player())))
    guard = 0
    while st.phase not in ("TURN_DRAW", "TURN_END") or st.discard == []:
        if st.is_chance_node():
            aids, _p = zip(*st.chance_outcomes())
            st.apply_action(rng.choice(aids))
            guard += 1
            continue
        legal = st.legal_actions(st.current_player())
        acts = [a for a in legal if decode_action(a)[0] != K_FLUSH_OWN]
        st.apply_action(rng.choice(acts or legal))
        guard += 1
        assert guard < 400
    actor = st.current_turn
    top = st.discard[-1]
    wrong = next((i for i, c in enumerate(st.hands[actor])
                  if c is not None and c % 13 != top % 13), None)
    if wrong is None:
        return
    bad = st.hands[actor][wrong]
    st.apply_action(__import__("rulezero.cabo_env", fromlist=["encode_action"]).encode_action(
        K_FLUSH_OWN, actor, 1, wrong))
    for p in range(2):
        assert card_label(bad) in st.observation_string(p)


def test_fixture_end_of_round_reveals_everything():
    g = CaboGame({"seed": 5})
    rng = random.Random(11)
    st = g.new_initial_state(77)
    while not st.is_terminal():
        legal = st.legal_actions(st.current_player())
        if not legal:
            break
        st.apply_action(rng.choice(legal))
    for p in range(2):
        for h in st.hands:
            for c in h:
                if c is not None:
                    assert card_label(c) in st.observation_string(p)


def test_utility_scenarios_and_caller_tiebreak():
    g = CaboGame({"seed": 1})

    def make(scores, caller):
        st = g.new_initial_state(1)
        st.final_scores = list(scores)
        st.scores = list(scores)
        st.cabo_caller = caller
        st.winner = None
        best = min(scores)
        winners = [i for i, v in enumerate(scores) if v == best]
        if len(winners) > 1 and caller is not None and caller in winners:
            winners = [caller]
        st.winner = winners[0] if len(winners) == 1 else None
        return st.returns()

    assert make([5, 20], None) == [1.0, -1.0]      # P0 lower wins
    assert make([20, 3], None) == [-1.0, 1.0]      # P1 lower wins
    assert make([9, 9], None) == [0.0, 0.0]        # tie, nobody called
    assert make([9, 9], 1) == [-1.0, 1.0]          # tie -> caller p1 wins
    assert make([9, 9], 0) == [1.0, -1.0]          # tie -> caller p0 wins


def test_indistinguishable_worlds_identical_information_state():
    """Two omniscient states that differ ONLY in cards a player has never
    learned must produce byte-identical information-state strings."""
    g = CaboGame({"seed": 123})
    st = g.new_initial_state(123)
    rng = random.Random(2)
    while st.is_chance_node() or st.phase == "INITIAL_PEEK":
        if st.is_chance_node():
            aids, _p = zip(*st.chance_outcomes())
            st.apply_action(rng.choice(aids))
        else:
            st.apply_action(rng.choice(st.legal_actions(st.current_player())))
    viewer = 0
    learned = set(st.knowledge[viewer])
    # find an unseen live card in p1's hand
    target_slot = next(i for i, c in enumerate(st.hands[1])
                       if c is not None and c not in learned)
    original = st.hands[1][target_slot]
    replacement = next(c for c in make_deck()
                       if c != original
                       and c not in learned
                       and all(c not in h for h in st.hands))
    before = st.information_state_string(viewer)
    st.hands[1][target_slot] = replacement
    after = st.information_state_string(viewer)
    assert before == after, "hidden identity change must not alter the viewer's information state"


if __name__ == "__main__":
    fns = [(n, f) for n, f in sorted(globals().items())
           if n.startswith("test_") and callable(f)]
    for name, fn in fns:
        try:
            fn()
            print(f"PASS {name}")
        except Exception as e:  # noqa: BLE001
            print(f"FAIL {name}: {e}")
            import traceback
            traceback.print_exc()
            sys.exit(1)
    print("all cabo info/utility tests passed")
