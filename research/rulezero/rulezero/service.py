"""RuleZero game service (Phase-2 Milestone 4, §16).

INTERNAL service: the TS Game Night server talks to this over stdio
line-JSON (same transport pattern as the cabo differential bridge). It is
NEVER exposed to browsers. TS learns NOTHING about generated game rules —
it forwards opaque spec JSON and renders whatever views this service emits.

Protocol `game-service/v1` — requests (one JSON object per line):
  {"op":"create","spec":{...GameSpec IR...},"seed":123}
  {"op":"view","player":0}
  {"op":"legalActions","player":0}
  {"op":"apply","player":0,"action":2}
  {"op":"snapshot"}                      # full state dict for reconnect
  {"op":"restore","state":{...}}         # from a previous snapshot
  {"op":"isTerminal"} / {"op":"returns"}
Responses: {"ok":true,...} or {"ok":false,"error":"..."}.

Views carry dense candidate ids A0..An plus the environment action ids
(§8), so a browser never sees raw packed integers as labels.
"""

from __future__ import annotations

import json
import random
import sys

from .gamespec_ir import ir_hash, load_ir
from .gamespec_runtime import IRGame

PROTOCOL = "game-service/v1"


class Session:
    """One game session: the OpenSpiel game + current state."""

    def __init__(self, spec_doc: dict, seed: int | None = None):
        self.ir = load_ir(spec_doc)
        self.spec_hash = ir_hash(self.ir)
        self.game = IRGame(self.ir)
        self.state = self.game.new_initial_state(None)
        # Server-side chance resolution: the canonical env exposes EXPLICIT
        # chance nodes (§6); this player-facing wrapper samples them so
        # clients (which must never drive randomness) see only decisions.
        self._rng = random.Random(0 if seed is None else int(seed))

    def _resolve_chance(self):
        guard = 0
        while self.state.is_chance_node() and not self.state.is_terminal():
            outs = self.state.chance_outcomes()
            cards, probs = zip(*outs)
            card = self._rng.choices(cards, weights=probs)[0]
            self.state.apply_action(int(card))
            guard += 1
            assert guard < 1000, "chance loop runaway"

    def snapshot(self) -> dict:
        st = self.state
        return {
            "protocol": PROTOCOL,
            "specHash": self.spec_hash,
            "zones": {k: list(v) for k, v in st.zones.items()},
            "zoneVis": dict(st.zone_vis),
            "vars": dict(st.vars),
            "phase": st.phase_idx,
            "actor": st.actor,
            "rotatePtr": st.rotate_ptr,
            "lastActor": st.last_actor,
            "chanceLeft": st.chance_left,
            "chanceActor": st.chance_actor,
            "window": None if st.window is None else {
                "queue": list(st.window["queue"]),
                "i": st.window["i"],
                "resume": st.window["resume"]},
            "history": [[int(p), int(a)] for p, a in st.history()],
        }

    def restore(self, snap: dict):
        if snap.get("specHash") != self.spec_hash:
            raise ValueError("snapshot/specHash mismatch")
        st = self.game.new_initial_state()
        st.zones = {k: list(v) for k, v in snap["zones"].items()}
        st.zone_vis = dict(snap["zoneVis"])
        st.vars = dict(snap["vars"])
        st.phase_idx = int(snap["phase"])
        st.actor = snap["actor"]
        st.rotate_ptr = int(snap["rotatePtr"])
        st.last_actor = snap["lastActor"]
        st.chance_left = int(snap["chanceLeft"])
        st.chance_actor = int(snap["chanceActor"])
        w = snap.get("window")
        st.window = None if not w else {
            "queue": tuple(w["queue"]), "i": int(w["i"]),
            "resume": int(w["resume"])}
        for p, a in snap.get("history", []):
            st.add_transition(int(p), int(a))
        self.state = st

    def view(self, player: int) -> dict:
        st = self.state
        table = [] if (st.is_terminal() or st.is_chance_node()) \
            else st._action_table()
        candidates = [{"candidateId": f"A{i}", "environmentActionId": i,
                       "label": st.action_to_string(player, i)}
                      for i in range(len(table))]
        return {
            "protocol": PROTOCOL,
            "specHash": self.spec_hash,
            "player": player,
            "observation": st.observation_string(player),
            "informationState": st.information_state_string(player),
            "isTerminal": st.is_terminal(),
            "currentActor": (None if st.is_terminal()
                             else st.current_player()),
            "candidates": candidates,
        }


def handle(session: Session | None, msg: dict) -> tuple[Session | None, dict]:
    op = msg.get("op")
    if op == "create":
        seed = msg.get("seed")
        session = Session(msg["spec"], None if seed is None else int(seed))
        session._resolve_chance()
        return session, {"ok": True, "protocol": PROTOCOL,
                         "players": session.game.num_players(),
                         "specHash": session.spec_hash}
    if session is None:
        return session, {"ok": False, "error": "no active session"}
    try:
        if op == "view":
            return session, {"ok": True, "view": session.view(int(msg["player"]))}
        if op == "legalActions":
            st = session.state
            acts = [] if st.is_terminal() or st.is_chance_node() \
                else st.legal_actions(st.current_player())
            return session, {"ok": True, "actions": acts}
        if op == "apply":
            session.state.apply_action(int(msg["action"]))
            session._resolve_chance()
            return session, {"ok": True,
                             "isTerminal": session.state.is_terminal()}
        if op == "snapshot":
            return session, {"ok": True, "snap": session.snapshot()}
        if op == "restore":
            session.restore(msg["state"])
            session._resolve_chance()
            return session, {"ok": True}
        if op == "isTerminal":
            return session, {"ok": True, "isTerminal": session.state.is_terminal()}
        if op == "returns":
            r = session.state.returns() if session.state.is_terminal() else None
            return session, {"ok": True, "returns": r}
        return session, {"ok": False, "error": f"unknown op {op!r}"}
    except Exception as e:  # noqa: BLE001 — protocol boundary
        return session, {"ok": False, "error": str(e)}


def serve(stdin=sys.stdin, stdout=sys.stdout):  # noqa: ANN001
    """Line-JSON request loop; one response line per request."""
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            resp = {"ok": False, "error": f"bad json: {e}"}
        else:
            global _SESSION
            _SESSION, resp = handle(_SESSION, msg)
        stdout.write(json.dumps(resp) + "\n")
        stdout.flush()


_SESSION: Session | None = None


if __name__ == "__main__":
    serve()
