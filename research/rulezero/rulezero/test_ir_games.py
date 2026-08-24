"""Three mechanically different games on ONE IR runtime (Milestone 3 gate).

- kuhnish: hidden-card betting (chance deal -> bet/check/fold/call -> showdown)
- goofseq: public prize rounds, resource bidding from private hands (no folds)
- claim:   bluffing with a generic REACTION WINDOW (accept/challenge)

Every game must pass the shared OpenSpiel compliance suite, keep private
zones private in observations, replay deterministically, and clone exactly.
"""

from __future__ import annotations

import random
import sys

from rulezero.compliance import run_compliance
from rulezero.gamespec_ir import IRValidationError, validate_ir
from rulezero.gamespec_runtime import compile_ir

KUHNISH = {
    "schemaVersion": 1,
    "name": "kuhnish",
    "players": {"count": 2},
    "entities": {"cardRanks": [9, 10, 11], "copiesPerRank": 1},
    "zones": [
        {"id": "deck", "visibility": "hidden"},
        {"id": "hand", "perPlayer": True, "visibility": "owner"},
    ],
    "vars": [
        {"id": "pot", "init": 0},
        {"id": "raised", "init": 0},
        {"id": "score0", "init": -1},
        {"id": "score1", "init": -1},
    ],
    "phases": [
        {"id": "deal", "kind": "chance",
         "chance": {"from": "deck", "to": "hand@p", "count": 1}},
        {"id": "act0", "kind": "decision",
         "decision": {"actor": 0, "actions": [
             {"id": "check", "goto": "act1"},
             {"id": "bet", "effects": [
                 {"op": "incr", "var": "pot", "by": 1},
                 {"op": "dec", "var": "score0", "by": 1},
                 {"op": "set", "var": "raised", "value": 1}],
              "goto": "act1"}]}},
        {"id": "act1", "kind": "decision",
         "decision": {"actor": 1, "actions": [
             {"id": "fold", "goto": "fold_award"},
             {"id": "call", "requires": {"var": "raised", "eq": 1},
              "effects": [{"op": "incr", "var": "pot", "by": 1},
                          {"op": "dec", "var": "score1", "by": 1}],
              "goto": "showdown"},
             {"id": "checkback", "requires": {"var": "raised", "eq": 0},
              "goto": "showdown"}]}},
        {"id": "showdown", "kind": "decision",
         "decision": {"actor": 0, "actions": [
             {"id": "reveal", "effects": [
                 {"op": "reveal", "zone": "hand@p"},
                 {"op": "compareGoto",
                  "a": {"sumRank": "hand@p"}, "b": {"sumRank": "hand@other"},
                  "gt": "win_revealer", "lt": "win_other", "eq": "tie"}]}]}},
        {"id": "fold_award", "kind": "award",
         "award": {"to": "otherOfLast", "amountVar": "pot",
                    "goto": "end"}},
        {"id": "win_revealer", "kind": "award",
         "award": {"to": "lastActor", "amountVar": "pot", "goto": "end"}},
        {"id": "win_other", "kind": "award",
         "award": {"to": "otherOfLast", "amountVar": "pot", "goto": "end"}},
        {"id": "tie", "kind": "award",
         "award": {"to": "splitAll", "amountVar": "pot", "goto": "end"}},
        {"id": "end", "kind": "terminal"},
    ],
}

GOOFSEQ = {
    "schemaVersion": 1,
    "name": "goofseq",
    "players": {"count": 2},
    # 9 cards: 6 are dealt into hands (3 bids each); 3 stay in the deck as
    # the face-up prize stack.
    "entities": {"cardRanks": [1, 3, 5], "copiesPerRank": 3},
    "zones": [
        {"id": "deck", "visibility": "hidden"},
        {"id": "prize", "visibility": "public"},
        {"id": "hand", "perPlayer": True, "visibility": "owner"},
        {"id": "bidA", "visibility": "hidden"},
        {"id": "bidB", "visibility": "hidden"},
    ],
    "vars": [
        {"id": "prizeval", "init": 0},
        {"id": "score0", "init": 0},
        {"id": "score1", "init": 0},
    ],
    "phases": [
        # deal the whole deck out round-robin: everyone sees their own hand
        {"id": "deal", "kind": "chance",
         "chance": {"from": "deck", "to": "hand@p", "count": 3}},
    ],
}
# Three prize rounds. Mechanic: public prize of unknown value; each seat
# secretly commits one card from a private hand (resource bidding).
for _round in range(3):
    GOOFSEQ["phases"] += [
        {"id": f"flip{_round}", "kind": "chance",
         "chance": {"from": "deck", "to": "prize", "count": 1,
                    "roundRobin": False}},
        {"id": f"price{_round}", "kind": "decision",
         "decision": {"actor": 0, "actions": [{
             "id": "value",
             "effects": [{"op": "set", "var": "prizeval",
                          "value": {"sumRank": "prize"}},
                         {"op": "clear", "zone": "bidA"},
                         {"op": "clear", "zone": "bidB"}]}]}},
        {"id": f"bidA{_round}", "kind": "decision",
         "decision": {"actor": 0, "actions": [
             {"id": f"play{r}",
              "requires": {"cardInHand": {"zone": "hand@p", "rank": r}},
              "effects": [{"op": "move", "from": "hand@p",
                           "to": "bidA", "rank": r}]}
             for r in (1, 3, 5)]}},
        {"id": f"bidB{_round}", "kind": "decision",
         "decision": {"actor": 1, "actions": [
             {"id": f"play{r}",
              "requires": {"cardInHand": {"zone": "hand@p", "rank": r}},
              "effects": [{"op": "move", "from": "hand@p",
                           "to": "bidB", "rank": r}]}
             for r in (1, 3, 5)]}},
        {"id": f"take{_round}", "kind": "award",
         "award": {"to": "compareZones",
                   "a": {"sumRank": "bidA"}, "b": {"sumRank": "bidB"},
                   "amountVar": "prizeval", "tieSplit": True,
                   "goto": ("end" if _round == 2
                            else f"flip{_round + 1}")}},
    ]
GOOFSEQ["phases"].append({"id": "end", "kind": "terminal"})

CLAIM = {
    "schemaVersion": 1,
    "name": "claim",
    "players": {"count": 2},
    "entities": {"cardRanks": [4, 10], "copiesPerRank": 1},
    "zones": [
        {"id": "deck", "visibility": "hidden"},
        {"id": "hand", "perPlayer": True, "visibility": "owner"},
    ],
    "vars": [
        {"id": "pot", "init": 2},
        {"id": "claimHigh", "init": 0},
        {"id": "score0", "init": -1},
        {"id": "score1", "init": -1},
    ],
    "phases": [
        {"id": "deal", "kind": "chance",
         "chance": {"from": "deck", "to": "hand@p", "count": 1}},
        {"id": "declare", "kind": "decision",
         "decision": {"actor": 0, "actions": [
             {"id": "claim_high", "effects": [
                 {"op": "set", "var": "claimHigh", "value": 1}]},
             {"id": "claim_low", "effects": [
                 {"op": "set", "var": "claimHigh", "value": 0}]}]}},
        # §5 generic reaction window: deterministic seat-order priority,
        # one decision for the eligible responder.
        {"id": "respond", "kind": "reaction",
         "reaction": {"actors": "allOthersAfterLastActor",
                      "priority": "seatOrder",
                      "actions": [
                          {"id": "accept", "endsWindow": True,
                           "effects": [{"op": "incr", "var": "pot", "by": 1},
                                       {"op": "dec", "var": "score1", "by": 1}],
                           "goto": "pay_claimer"},
                          {"id": "challenge", "endsWindow": True,
                           "effects": [{"op": "reveal", "zone": "hand@p"},
                                       {"op": "set", "var": "cardval",
                                        "value": {"sumRank": "hand@p"}}],
                           "goto": "judge_high"}]}},
        {"id": "pay_claimer", "kind": "award",
         "award": {"to": "otherOfLast", "amountVar": "pot", "goto": "end"}},
        {"id": "judge_high", "kind": "decision",
         "decision": {"actor": 0, "actions": [{
             "id": "resolve",
             "effects": [{"op": "compareGoto",
                          "a": {"sumRank": "hand@p"}, "b": 10,
                          "gt": "hi_true", "lt": "judge_low", "eq": "hi_true"}]
             }]}},
        {"id": "judge_low", "kind": "decision",
         "decision": {"actor": 0, "actions": [{
             "id": "resolve_low",
             "effects": [{"op": "compareGoto",
                          "a": 4, "b": {"sumRank": "hand@p"},
                          "gt": "lo_true", "lt": "hi_true", "eq": "lo_true"}]
             }]}},
        {"id": "hi_true", "kind": "decision",
         "decision": {"actor": 0, "actions": [
             {"id": "claim_was_high", "requires": {"var": "claimHigh", "eq": 1},
              "goto": "claimer_wins"},
             {"id": "claim_was_low", "requires": {"var": "claimHigh", "eq": 0},
              "goto": "responder_wins"}]}},
        {"id": "lo_true", "kind": "decision",
         "decision": {"actor": 0, "actions": [
             {"id": "claim_was_high_l", "requires": {"var": "claimHigh", "eq": 1},
              "goto": "responder_wins"},
             {"id": "claim_was_low_l", "requires": {"var": "claimHigh", "eq": 0},
              "goto": "claimer_wins"}]}},
        {"id": "claimer_wins", "kind": "award",
         "award": {"to": "lastActor", "amountVar": "pot", "goto": "end"}},
        {"id": "responder_wins", "kind": "award",
         "award": {"to": "lastActor", "amountVar": "pot", "goto": "end"}},
        {"id": "end", "kind": "terminal"},
    ],
}

SPECS = {"kuhnish": KUHNISH, "goofseq": GOOFSEQ, "claim": CLAIM}


def main() -> int:
    ok = True
    rng = random.Random(0)
    for name, doc in SPECS.items():
        game, digest = compile_ir(doc)
        assert len(digest) == 64
        fails = run_compliance(game, episodes=30)
        print(("PASS" if not fails else "FAIL"), f"compliance ir_{name}")
        for m in fails[:5]:
            print("   -", m)
        ok = ok and not fails

        # privacy: non-owner never sees owner-zone contents pre-terminal.
        # Parse per-zone segments ("zid=[...]") so digits from OTHER zones
        # cannot false-positive.
        def _zone_exposes(obs: str, zid: str, cards) -> bool:
            for seg in obs.split():
                if seg.startswith(zid + "=["):
                    body = seg[len(zid) + 2:]
                    shown = [int(x) for x in
                             body.rstrip("]").split(",") if x.strip().isdigit()]
                    return sorted(shown) != sorted(set(cards)) or bool(cards)
            return False

        leaks = 0
        st = game.new_initial_state()
        while not st.is_terminal():
            if st.is_chance_node():
                aids, _ = zip(*st.chance_outcomes())
                st.apply_action(rng.choice(aids))
                continue
            for p in range(game.num_players()):
                obs = st.observation_string(p)
                for q in range(game.num_players()):
                    zid = f"hand{q}"
                    if q == p or st.zone_vis.get(zid) == "public":
                        continue
                    if _zone_exposes(obs, zid, st.zones[zid]) and st.zones[zid]:
                        leaks += 1
            legal = st.legal_actions(st.current_player())
            if not legal:
                break
            st.apply_action(rng.choice(legal))
        print(("PASS" if leaks == 0 else "FAIL"), f"privacy ir_{name} ({leaks} leaks)")
        ok = ok and leaks == 0

        # determinism: same script -> same final string
        def play(script_rng):
            s = game.new_initial_state()
            while not s.is_terminal():
                if s.is_chance_node():
                    aids, _ = zip(*s.chance_outcomes())
                    s.apply_action(script_rng.choice(aids))
                else:
                    s.apply_action(
                        script_rng.choice(s.legal_actions(s.current_player())))
            return str(s)

        r1, r2 = random.Random(77), random.Random(77)
        print(("PASS" if play(r1) == play(r2) else "FAIL"), f"determinism ir_{name}")
        ok = ok and play(r1) == play(r2)

    # reaction-window traversal proof for claim (§5 gate, generic runtime):
    reached_window = 0
    g, _ = compile_ir(CLAIM)
    for eps in range(60):
        s = g.new_initial_state()
        r = random.Random(eps)
        while not s.is_terminal():
            if s.window is not None:
                reached_window += 1
            if s.is_chance_node():
                aids, _ = zip(*s.chance_outcomes())
                s.apply_action(r.choice(aids))
            else:
                legal = s.legal_actions(s.current_player())
                if not legal:
                    break
                s.apply_action(r.choice(legal))
        if not s.is_terminal():
            print(f"FAIL claim ep{eps} did not finish")
            ok = False
    print(f"{'PASS' if reached_window >= 60 else 'FAIL'} "
          f"claim reaction-window traversals ({reached_window})")
    ok = ok and reached_window >= 60

    # ---- §12: restoration round-trip + §7 perfect-recall witness -------
    from rulezero.gamespec_runtime import IRState

    def _to_dict(st: IRState) -> dict:
        return {"zones": st.zones, "vis": st.zone_vis, "vars": st.vars,
                "phase": st.phase_idx, "actor": st.actor,
                "rot": st.rotate_ptr, "last": st.last_actor,
                "cl": st.chance_left, "ca": st.chance_actor,
                "win": st.window}

    def _from_dict(game, d: dict) -> IRState:
        st = IRState(game)
        st.zones = {k: list(v) for k, v in d["zones"].items()}
        st.zone_vis = dict(d["vis"])
        st.vars = dict(d["vars"])
        st.phase_idx = d["phase"]
        st.actor = d["actor"]
        st.rotate_ptr = d["rot"]
        st.last_actor = d["last"]
        st.chance_left = d["cl"]
        st.chance_actor = d["ca"]
        st.window = None if d["win"] is None else {
            "queue": tuple(d["win"]["queue"]), "i": d["win"]["i"],
            "resume": d["win"]["resume"]}
        return st

    gk, _ = compile_ir(KUHNISH)
    mid = gk.new_initial_state()
    rr = random.Random(4)
    while not mid.is_terminal() and mid.phase_idx < 2:
        if mid.is_chance_node():
            aids, _p = zip(*mid.chance_outcomes())
            mid.apply_action(rr.choice(aids))
        else:
            mid.apply_action(rr.choice(mid.legal_actions(mid.current_player())))
    restored = _from_dict(gk, _to_dict(mid))
    print(("PASS" if str(restored) == str(mid) and
           restored.observation_string(0) == mid.observation_string(0)
           else "FAIL"), "restore round-trip ir_kuhnish")
    ok = ok and str(restored) == str(mid)

    # Perfect recall / indistinguishability: two worlds differing ONLY in
    # p1's hidden card are indistinguishable to p0.
    w1, w2 = gk.new_initial_state(), gk.new_initial_state()
    for w, card1 in ((w1, 10), (w2, 11)):
        w.apply_action(9)           # p0 gets the SAME card in both worlds
        w.apply_action(card1)       # p1's card differs
    same = (w1.information_state_string(0) == w2.information_state_string(0))
    print(("PASS" if same else "FAIL"), "perfect-recall indistinguishable worlds")
    ok = ok and same
    differ_for_p1 = w1.information_state_string(1) != w2.information_state_string(1)
    print(("PASS" if differ_for_p1 else "FAIL"),
          "information states distinguish for the owner")
    ok = ok and differ_for_p1

    # validator rejects broken specs
    try:
        bad = dict(KUHNISH)
        bad["phases"] = [p for p in KUHNISH["phases"]
                         if p.get("kind") != "terminal"]
        validate_ir(bad)
        print("FAIL validator accepted terminal-less spec")
        ok = False
    except IRValidationError:
        print("PASS validator rejects terminal-less spec")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
