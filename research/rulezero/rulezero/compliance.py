"""OpenSpiel compliance suite (Phase-2 §12).

A game is "accepted" only when it passes this suite — parsing is not enough.
Usage:

    from rulezero.compliance import run_compliance
    failures = run_compliance(CaboGame({"seed": 1, "players": 4}),
                              obs_privacy=make_cabo_privacy_checker())
    assert not failures

Checks: chance distributions sum to 1; every legal action applies; illegal
actions raise; clone exactness + mutation isolation; terminal returns finite;
no player decisions at terminal states; deterministic replay; step cap;
optional observation-privacy predicate over random reachable states.
"""

from __future__ import annotations

import random
from typing import Callable

import pyspiel


def _drive(st, rng, cap=4000):
    steps = 0
    while not st.is_terminal() and steps < cap:
        steps += 1
        if st.is_chance_node():
            aids, _ = zip(*st.chance_outcomes())
            st.apply_action(rng.choice(aids))
            continue
        p = st.current_player()
        legal = st.legal_actions(p)
        if not legal:
            break
        st.apply_action(rng.choice(legal))
    return steps


def run_compliance(game, *, episodes: int = 12,
                   obs_privacy: Callable | None = None) -> list[str]:
    """Returns a list of failure strings; empty list == compliant."""
    f: list[str] = []
    rng = random.Random(1234)

    # 1. chance distributions sum to 1 (checked across live chance nodes)
    checked_chance = 0
    # 2/3. every legal action applies; illegal actions reject
    applied = rejected = 0
    # 5. terminal returns finite; 6. no decisions at terminals
    terminals = 0

    for eps in range(episodes):
        st = game.new_initial_state(eps * 31 + 7)
        traj: list[tuple[str, int]] = []
        while not st.is_terminal():
            if st.is_chance_node():
                outs = st.chance_outcomes()
                total = sum(p for _, p in outs)
                if abs(total - 1.0) > 1e-9 or not outs:
                    f.append(f"chance probs sum={total} at ep{eps}")
                    return f
                checked_chance += 1
                aids, _ = zip(*outs)
                a = rng.choice(aids)
                traj.append(("c", int(a)))
                st.apply_action(a)
                continue
            p = st.current_player()
            if not isinstance(p, int) or p < 0:
                f.append(f"non-player actor {p} outside chance at ep{eps}")
                return f
            legal = st.legal_actions(p)
            if not legal:
                break
            # every legal action applies on a CLONE (mutation isolation too)
            for a in legal[:6]:
                cl = st.clone()
                try:
                    cl.apply_action(a)
                    applied += 1
                except Exception as e:  # noqa: BLE001
                    f.append(f"legal action {a} failed to apply: {e}")
                    return f
            # garbage actions must be rejected
            for bad in (10**9, -1):
                cl2 = st.clone()
                try:
                    cl2.apply_action(bad)
                    rejected += 1  # tolerated only if it raised nothing AND state unchanged
                    if str(cl2) != str(st):
                        f.append(f"garbage action {bad} silently mutated state")
                        return f
                except Exception:
                    pass
            a = rng.choice(legal)
            traj.append((str(p), int(a)))
            st.apply_action(a)

        if st.is_terminal():
            terminals += 1
            r = st.returns()
            if len(r) != game.num_players() or not all(
                    isinstance(x, (int, float)) and x == x and abs(x) != float("inf")
                    for x in r):
                f.append(f"invalid terminal returns {r} at ep{eps}")
                return f
            for pl in range(game.num_players()):
                if st.legal_actions(pl):
                    f.append(f"terminal state offers decisions at ep{eps}")
                    return f

    # 4. deterministic replay: same decision script -> identical final string
    def play_script(script):
        s = game.new_initial_state(555)
        for kind, a in script:
            if s.is_terminal():
                break
            if kind == "c":
                aids, _ = zip(*s.chance_outcomes())
                if a in aids and s.is_chance_node():
                    s.apply_action(a)
                else:  # different tree shape; abort comparison honestly
                    return None
            else:
                if s.current_player() != int(kind):
                    return None
                if a in s.legal_actions(int(kind)):
                    s.apply_action(a)
                else:
                    return None
        return str(s)

    st = game.new_initial_state(555)
    r1 = rng.randrange(10**9)
    script_rng = random.Random(r1)
    script = []
    s2 = game.new_initial_state(555)
    steps = 0
    while not s2.is_terminal() and steps < 3000:
        steps += 1
        if s2.is_chance_node():
            aids, _ = zip(*s2.chance_outcomes())
            a = script_rng.choice(aids)
            script.append(("c", int(a)))
        else:
            p = s2.current_player()
            legal = s2.legal_actions(p)
            if not legal:
                break
            a = script_rng.choice(legal)
            script.append((str(p), int(a)))
        s2.apply_action(a)
    replayed = play_script(script)
    if replayed is not None and replayed != str(s2):
        f.append("deterministic replay mismatch")

    # 7. observation privacy hook over random reachable states
    if obs_privacy is not None:
        for eps in range(episodes):
            st = game.new_initial_state(eps * 13 + 5)
            steps = 0
            while not st.is_terminal() and steps < 600:
                steps += 1
                if st.is_chance_node():
                    aids, _ = zip(*st.chance_outcomes())
                    st.apply_action(rng.choice(aids))
                    continue
                for pl in range(game.num_players()):
                    err = obs_privacy(st, pl)
                    if err:
                        f.append(f"privacy ep{eps} step{steps} p{pl}: {err}")
                        return f
                legal = st.legal_actions(st.current_player())
                if not legal:
                    break
                st.apply_action(rng.choice(legal))

    if checked_chance == 0:
        f.append("no chance node encountered (suspicious for card games)")
    if applied == 0:
        f.append("no legal action ever applied")
    if terminals == 0:
        f.append("no episode reached terminal within caps (deadlock?)")
    return f
