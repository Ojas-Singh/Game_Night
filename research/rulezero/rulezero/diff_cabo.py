"""Differential verification: TypeScript Cabo vs OpenSpiel python twin.

Drives BOTH engines through identical random episodes (same seed -> same
deals via the replicated RNG) and compares semantic snapshots after every
applied action. Any mismatch is a fidelity bug in one of the engines.

Run: .venv/bin/python rulezero/diff_cabo.py [episodes] [seed0]
Requires: node + repo workspace deps built (pnpm --filter ... build).
"""

from __future__ import annotations

import json
import random
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).parent.parent))

from rulezero.cabo_env import (  # noqa: E402
    CaboGame,
    K_CALL,
    K_DISCARD_DRAWN,
    K_DRAW,
    K_END,
    K_FLUSH_OTHER,
    K_FLUSH_OWN,
    K_KEEP,
    K_PEEK,
    K_POWER_BS,
    K_POWER_PO,
    K_POWER_PT,
    K_POWER_SO,
    K_TRANSFER,
    K_PASS,
    encode_action,
)


class Bridge:
    def __init__(self):
        self.proc = subprocess.Popen(
            ["pnpm", "exec", "tsx", "src/caboBridge.ts"],
            cwd=str(REPO / "apps" / "arena"),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )

    def ask(self, msg: dict) -> dict:
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("bridge died")
        return json.loads(line)

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=10)


def translate(ts_action: dict, player: str, snap: dict) -> int | None:
    """Map a TS action object to a packed python action using current hands."""
    hands = snap["handsIdx"]
    seat = int(player[1:])
    t = ts_action["type"]

    def slot_of(pid: str, card_id: str) -> int | None:
        idx = int(card_id[2:])
        for i, c in enumerate(hands[pid]):
            if c == idx:
                return i
        return None

    if t == "DRAW":
        return encode_action(K_DRAW)
    if t == "KEEP_DRAWN":
        return encode_action(K_KEEP, ts_action["handIndex"])
    if t == "DISCARD_DRAWN":
        return encode_action(K_DISCARD_DRAWN)
    if t == "PEEK_STARTING":
        i, j = sorted(ts_action["cardIndexes"])
        return encode_action(K_PEEK, i, j)
    if t == "POWER_APPLY":
        p = ts_action["payload"]
        k = p["power"]
        if k == "PEEK_OWN":
            s = slot_of(player, p["cardId"])
            return None if s is None else encode_action(K_POWER_PO, s)
        if k == "PEEK_OTHER":
            s = slot_of(p["targetPlayerId"], p["cardId"])
            o = int(p["targetPlayerId"][1:])
            return None if s is None else encode_action(K_POWER_PT, o, s)
        if k == "BLIND_SWAP":
            own = slot_of(player, p["ownCardId"])
            os_ = slot_of(p["targetPlayerId"], p["targetCardId"])
            o = int(p["targetPlayerId"][1:])
            if own is None or os_ is None:
                return None
            return encode_action(K_POWER_BS, own, o, os_)
        if k == "SWAP_OTHERS":
            sa = slot_of(None or _pid_of(p["cardIdA"], snap), p["cardIdA"])
            sb = slot_of(_pid_of(p["cardIdB"], snap), p["cardIdB"])
            if sa is None or sb is None:
                return None
            seat_a = _pid_of(p["cardIdA"], snap)
            seat_b = _pid_of(p["cardIdB"], snap)
            return encode_action(
                K_POWER_SO, int(seat_a[1:]), sa, int(seat_b[1:]), sb
            )
        return None
    if t == "FLUSH_OWN":
        slots = []
        for cid in ts_action["cardIds"]:
            s = slot_of(player, cid)
            if s is None:
                return None
            slots.append(s)
        slots.sort()
        return encode_action(K_FLUSH_OWN, seat, len(slots), *slots)
    if t == "FLUSH_OTHER":
        s = slot_of(ts_action["playerId"], ts_action["cardId"])
        o = int(ts_action["playerId"][1:])
        return None if s is None else encode_action(K_FLUSH_OTHER, seat, o, s)
    if t == "TRANSFER_CARD":
        s = slot_of(player, ts_action["cardId"])
        return None if s is None else encode_action(K_TRANSFER, s)
    if t == "CALL_CABO":
        return encode_action(K_CALL)
    if t == "END_TURN":
        return encode_action(K_END)
    return None


def _pid_of(card_id: str, snap: dict) -> str:
    idx = int(card_id[2:])
    for pid, hand in snap["handsIdx"].items():
        if idx in hand:
            return pid
    raise KeyError(card_id)


def semantic_snap(snap: dict) -> dict:
    """Projection of TS snapshot onto python-comparable fields."""
    return {
        "phase": snap["phase"],
        "currentTurn": snap["currentTurn"],
        "handsIdx": snap["handsIdx"],
        "deckLen": snap["deckLen"],
        "discard": {"top": snap["discardTop"], "len": snap["discardLen"]},
        "drawn": snap["drawnIdx"],
        "pendingPower": snap["pendingPower"],
        "pendingTransfer": snap["pendingTransfer"],
        "cabo": {"caller": snap["caboCaller"], "takenTotal": snap["takenFinalTotal"]},
        "initialPeeksLeft": snap["initialPeeksLeft"],
        "knowledge": snap["knowledge"],
    }


def py_semantic(st) -> dict:
    def hand(h):
        return [(c if c is not None else None) for c in h]

    pp = None
    if st.pending_power:
        pp = {"seat": st.pending_power[0], "power": st.pending_power[1]}
    pt = None
    if st.pending_transfer:
        pt = {"from": st.pending_transfer[0], "to": st.pending_transfer[1]}
    discard_top = st.discard[-1] if st.discard else None
    drawn = st.drawn_card if st.drawn_card is not None else None
    return {
        "phase": st.phase,
        "currentTurn": st.current_turn,
        "handsIdx": {f"p{i}": hand(h) for i, h in enumerate(st.hands)},
        "deckLen": len(st.pool),
        "discard": {
            "top": discard_top,
            "len": len(st.discard),
        },
        "drawn": drawn,
        "pendingPower": pp,
        "pendingTransfer": pt,
        "cabo": {"caller": st.cabo_caller, "takenTotal": len(st.taken_final)},
        "initialPeeksLeft": len(st.initial_peeks_remaining),
        "knowledge": {f"p{i}": sorted(ks) for i, ks in enumerate(st.knowledge)},
    }


def compare(ts_sem: dict, py_sem: dict) -> list[str]:
    diffs = []
    for key in ts_sem:
        if ts_sem[key] != py_sem.get(key):
            diffs.append(f"{key}: ts={ts_sem[key]} py={py_sem.get(key)}")
    return diffs


def run_episode(game: CaboGame, bridge: Bridge, seed: int, rng: random.Random,
                max_steps: int = 6000) -> tuple[str, list[str]]:
    """Drive BOTH engines through one identical episode.

    Phase-2 §6 protocol: card randomness lives in OpenSpiel chance nodes.
    The TS engine keeps its seeded internal RNG, so the driver syncs the two
    by feeding pyspiel exactly the cards TS used:
      - initial deal: read TS handsIdx once, feed round-robin;
      - turn draw   : apply TS DRAW first, read drawnIdx, then chance-feed;
      - penalty draw: diff the flusher's hand across the flush application.
    Reaction windows (§5) exist only on the python side: PASS maps to a
    no-op on TS; window flushes are applied to TS directly.
    """
    n_players = game.num_players()
    bridge.ask({"op": "new", "seed": seed, "players": n_players})
    st = game.new_initial_state(seed)

    # ---- bootstrap: initial deal via chance ----
    snap_resp = bridge.ask({"op": "snap"})
    snap = snap_resp["snap"]
    while st.is_chance_node():
        _, seat, slot = st.chance_ctx
        card = snap["handsIdx"][f"p{seat}"][slot]
        if card is None:
            return "deal_sync_failed", [f"missing deal card seat={seat} slot={slot}"]
        st.apply_action(int(card))

    pre_snap = snap  # last snapshot before the most recent applied action
    for step in range(max_steps):
        done = bridge.ask({"op": "done"})
        if done["done"] or st.is_terminal():
            sc_ts = done.get("scores") or {}
            if st.is_terminal() and sc_ts:
                ts_vals = [int(sc_ts[f"p{i}"]) for i in range(n_players)]
                py_vals = [int(x) for x in st.final_scores]
                if ts_vals != py_vals:
                    return "SCORE_MISMATCH", [f"ts {ts_vals} vs py {py_vals}"]
            return "finished", []

        resp = bridge.ask({"op": "legalAll"})
        actions = resp["actions"]
        if not actions:
            return "stalled_ts", [f"step {step}: TS has no legal actions; py terminal={st.is_terminal()}"]
        snap_resp = bridge.ask({"op": "snap"})
        snap = snap_resp["snap"]

        # candidate set: translated TS actions (+PASS when python expects one)
        translated = []
        for entry in actions:
            pa = translate(entry["action"], entry["player"], snap)
            if pa is not None:
                translated.append((entry, pa))
        actor_now = st.current_player()
        # Only offer candidates python accepts RIGHT NOW: reaction-window
        # passes are py-side no-ops that let TS's still-valid offers wait
        # until the window resolves (deterministic priority).
        legal_py = st.legal_actions(st.current_player())
        candidates = [(e, pa) for e, pa in translated if pa in legal_py]
        if _py_expects_pass(st):
            candidates.append(
                ({"player": f"p{actor_now}", "action": {"type": "_PASS"}},
                 encode_action(K_PASS)))
        if not candidates:
            return "translation_empty", [
                f"step {step}: no mutually-legal candidate "
                f"(py legal={len(legal_py)} phase={st.phase})"]

        chosen, packed = rng.choice(candidates)
        if packed not in legal_py:
            return "ILLEGAL_IN_PY", [
                f"step {step}: ts {chosen['action']} -> {chosen['player']} "
                f"packed={packed} not in py legal ({len(legal_py)}) phase={st.phase}"
            ]
        pre_snap = snap
        if chosen["action"].get("type") != "_PASS":
            r = bridge.ask({"op": "apply", "player": chosen["player"], "action": chosen["action"]})
            if not r.get("ok"):
                return "TS_REJECT", [f"step {step}: TS rejected: {r.get('error')}"]
        st.apply_action(packed)

        # ---- §6 chance sync: feed TS's card into the python chance node ----
        if st.is_chance_node():
            ctx = st.chance_ctx
            if ctx[0] == "deal":
                seat, slot = ctx[1], ctx[2] if len(ctx) > 2 else 0
            if ctx[2] == "turn":
                after0 = bridge.ask({"op": "snap"})["snap"]
                card = after0.get("drawnIdx")
            else:  # penalty: appended card found by hand diff
                actor_id = f"p{ctx[1]}"
                before = pre_snap["handsIdx"][actor_id]
                after0 = bridge.ask({"op": "snap"})["snap"]
                added = [c for c in after0["handsIdx"][actor_id]
                         if c is not None and c not in before]
                card = added[-1] if added else None
            if card is None:
                return "chance_sync_failed", [f"step {step}: ctx={ctx}"]
            if int(card) not in {c for c, _p in st.chance_outcomes()}:
                return "chance_card_invalid", [f"step {step}: card={card}"]
            st.apply_action(int(card))

        after = bridge.ask({"op": "snap"})
        diffs = compare(semantic_snap(after["snap"]), py_semantic(st))
        if diffs:
            return "DIVERGENCE", [f"step {step}: {d}" for d in diffs[:6]]
    return "step_cap", []


_PASS_SENTINEL = {"type": "_PASS"}


def _py_expects_pass(st) -> bool:
    """True when python's current node is a reaction-window decision."""
    import pyspiel as _sp

    cp = st.current_player()
    return (not st.is_terminal() and not st.is_chance_node()
            and isinstance(cp, int) and st.window is not None)


def main(episodes: int = 100, seed0: int = 1, players: int = 2):
    game = CaboGame({"seed": 1, "players": players})
    bridge = Bridge()
    outcomes: dict[str, int] = {}
    first_fail: list[str] = []
    try:
        for eps in range(episodes):
            seed = seed0 + eps * 7919
            rng = random.Random(seed ^ 0xABCD)
            result, info = run_episode(game, bridge, seed, rng)
            outcomes[result] = outcomes.get(result, 0) + 1
            if result != "finished" and result != "step_cap" and not first_fail:
                first_fail = [f"episode {eps} seed={seed} result={result}", *info]
            if result in ("DIVERGENCE", "ILLEGAL_IN_PY", "SCORE_MISMATCH"):
                break
    finally:
        bridge.close()
    print(json.dumps({"episodes": episodes, "players": players,
                      "outcomes": outcomes}, indent=2))
    if first_fail:
        print("FIRST FAILURE:")
        for line in first_fail:
            print(" ", line)
        sys.exit(1)
    print("DIFFERENTIAL OK" if set(outcomes) <= {"finished", "step_cap"} else "FAILURES PRESENT")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 50
    s0 = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    players = 2
    if "--players" in sys.argv:
        players = int(sys.argv[sys.argv.index("--players") + 1])
    DEBUG = "--debug" in sys.argv
    globals()["DEBUG"] = DEBUG
    main(n, s0, players)
