"""RuleZero game service (Phase-2 Milestone 4, §16).

INTERNAL service: the TS Game Night server talks to this over stdio
line-JSON (same transport pattern as the cabo differential bridge). It is
NEVER exposed to browsers. TS learns NOTHING about generated game rules —
it forwards opaque spec JSON and renders whatever views this service emits.

Protocol `game-service/v2` — requests (one JSON object per line):
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
from .gamespec_runtime import IRGame, RUNTIME_VERSION

PROTOCOL = "game-service/v2"


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
        # §14 post-game review log: every human-visible decision, with the
        # actor's own information state and labeled candidates.
        self.review_log: list[dict] = []
        self.trajectory: list[dict] = []
        self.revision = 0
        self.commands: dict[str, dict] = {}
        self._agents: dict[str, object] = {}

    def _record_decision(self):
        st = self.state
        if st.is_terminal() or st.is_chance_node():
            return
        player = st.current_player()
        legal = sorted(st.legal_actions(player))
        self.review_log.append({
            "t": len(self.review_log),
            "kind": "decision",
            "player": int(player),
            "infoState": st.information_state_string(player),
            "candidates": [
                {"candidateId": f"A{i}", "environmentActionId": a,
                 "label": st.action_to_string(player, a)}
                for i, a in enumerate(legal)
            ],
        })

    def _resolve_chance(self):
        guard = 0
        while self.state.is_chance_node() and not self.state.is_terminal():
            outs = self.state.chance_outcomes()
            cards, probs = zip(*outs)
            card = self._rng.choices(cards, weights=probs)[0]
            self.trajectory.append({
                "t": len(self.trajectory), "kind": "chance", "player": -1,
                "outcomes": [{"environmentActionId": int(a), "probability": float(p)} for a, p in outs],
                "chosenEnvironmentActionId": int(card),
            })
            self.state.apply_action(int(card))
            guard += 1
            assert guard < 1000, "chance loop runaway"

    def snapshot(self) -> dict:
        st = self.state
        return {
            "protocol": PROTOCOL,
            "runtimeVersion": RUNTIME_VERSION,
            "revision": self.revision,
            "specHash": self.spec_hash,
            "zones": {k: list(v) for k, v in st.zones.items()},
            "zoneVis": dict(st.zone_vis),
            "vars": dict(st.vars),
            "varVis": dict(st.var_vis),
            "varOwner": dict(st.var_owner),
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
            "history": [[int(p), int(a)] for p, a in st.full_history()],
            "recall": st._recall,
            "rngState": self._rng.getstate(),
            "reviewLog": self.review_log,
            "trajectory": self.trajectory,
            "commands": self.commands,
        }

    def restore(self, snap: dict):
        if snap.get("specHash") != self.spec_hash:
            raise ValueError("snapshot/specHash mismatch")
        if snap.get("runtimeVersion") != RUNTIME_VERSION:
            raise ValueError("incompatible runtime snapshot")
        st = self.game.new_initial_state()
        st.zones = {k: list(v) for k, v in snap["zones"].items()}
        st.zone_vis = dict(snap["zoneVis"])
        st.vars = dict(snap["vars"])
        st.var_vis = dict(snap.get("varVis", {k: "public" for k in st.vars}))
        st.var_owner = dict(snap.get("varOwner", {k: None for k in st.vars}))
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
        st._recall = [list(h) for h in snap["recall"]]
        def tuples(value):
            return tuple(tuples(x) for x in value) if isinstance(value, list) else value
        self._rng.setstate(tuples(snap["rngState"]))
        self.revision = snap["revision"]
        self.review_log = list(snap["reviewLog"])
        self.trajectory = list(snap.get("trajectory", []))
        self.commands = dict(snap["commands"])
        self.state = st

    def apply(self, msg: dict) -> dict:
        player = msg.get("player")
        if type(player) is not int or not 0 <= player < self.game.num_players():
            raise ValueError("authenticated player required")
        command_id = msg.get("commandId")
        key = f"{player}:{command_id}" if command_id else None
        signature = [msg.get("action"), msg.get("expectedRevision")]
        if key in self.commands:
            cached = self.commands[key]
            if cached["signature"] != signature:
                raise ValueError("command id reused with different payload")
            return cached["result"]
        if player != self.state.current_player():
            raise ValueError("not your turn")
        if msg.get("expectedRevision", self.revision) != self.revision:
            raise ValueError("stale revision")
        action = msg.get("action")
        if type(action) is not int or action not in self.state.legal_actions(player):
            raise ValueError("illegal action")
        snap = json.loads(json.dumps(self.snapshot()))
        try:
            self._record_decision()
            self.review_log[-1]["chosenAction"] = action
            self.review_log[-1]["chosenEnvironmentActionId"] = action
            self.review_log[-1]["chosenCandidateId"] = f"A{action}"
            decision = self.review_log[-1]
            self.state.apply_action(action)
            self.trajectory.append({
                "t": len(self.trajectory), "kind": "decision",
                "player": int(player), "infoState": decision["infoState"],
                "candidates": decision["candidates"],
                "legalEnvironmentActions": [c["environmentActionId"] for c in decision["candidates"]],
                "chosenCandidateId": f"A{action}",
                "chosenEnvironmentActionId": int(action),
                "policy": None, "valueTarget": None, "teacherPolicy": None,
            })
            self._resolve_chance()
            self.revision += 1
            if self.state.is_terminal():
                from .artifacts import ArtifactStore
                import os
                from pathlib import Path
                root = Path(os.environ.get('RULEZERO_TRAJECTORIES', Path(__file__).resolve().parent.parent / 'artifacts' / 'trajectories'))
                record = {'schemaVersion': 2, 'game': {'id': 'gamespec:' + self.spec_hash, 'specHash': self.spec_hash, 'numPlayers': self.game.num_players()},
                          'completed': True, 'returns': self.state.returns(), 'transitions': self.trajectory,
                          'provenance': {'runner': 'rulezero.service/v2', 'runtimeVersion': RUNTIME_VERSION}}
                ArtifactStore(root).put_json(record, kind='live-trajectory')
            result = {"ok": True, "isTerminal": self.state.is_terminal(),
                      "revision": self.revision}
            if key:
                self.commands[key] = {"signature": signature, "result": result}
            return result
        except Exception:
            self.restore(snap)
            raise

    def view(self, player: int) -> dict:
        """Structured per-player view. Zone contents are filtered by
        VISIBILITY AT THE SOURCE: hidden zones expose only counts, owner
        zones only to their owner, public zones to everyone. The browser
        can therefore render exactly what it receives — no string parsing,
        no way to leak what was never sent."""
        if type(player) is not int or not -1 <= player < self.game.num_players():
            raise ValueError("invalid viewer")
        st = self.state
        table = [] if (st.is_terminal() or st.is_chance_node() or player != st.current_player()) \
            else st._action_table()
        candidates = [{"candidateId": f"A{i}", "environmentActionId": i,
                       "label": st.action_to_string(player, i)}
                      for i in range(len(table))]

        def zone_entry(zid: str) -> dict:
            vis = st.zone_vis.get(zid, "hidden")
            cards = st.zones.get(zid, [])
            digits = ''.join(ch for ch in zid if ch.isdigit())
            owner = int(digits) if digits else None
            if vis == "public" or (vis == "owner" and owner == player) \
                    or (st.is_terminal() and player >= 0):
                return {"id": zid, "visibility": vis, "owner": owner,
                        "cards": list(cards)}
            return {"id": zid, "visibility": vis, "owner": owner,
                    "count": len(cards)}

        zones = [zone_entry(zid) for zid in sorted(st.zones)]
        scores = {k[5:]: v for k, v in sorted(st.visible_vars(player).items())
                  if k.startswith("score")}
        return {
            "protocol": PROTOCOL,
            "runtimeVersion": RUNTIME_VERSION,
            "revision": self.revision,
            "specHash": self.spec_hash,
            "player": player,
            "phase": st.ir["phases"][st.phase_idx]["id"],
            "observation": st.observation_string(player),
            "informationState": st.information_state_string(player),
            "isTerminal": st.is_terminal(),
            "currentActor": (None if st.is_terminal()
                             else st.current_player()),
            "candidates": candidates,
            "zones": zones,
            "scores": scores,
        }


def handle(session: Session | None, msg: dict) -> tuple[Session | None, dict]:
    op = msg.get("op")
    # --- Game Lab ops (§15/§12): stateless, no session required ---------
    if op == "labCheckpoints":
        from .checkpoint_registry import list_checkpoints
        return session, {"ok": True, "checkpoints": list_checkpoints()}
    if op == "labLearningRuns":
        from .checkpoint_registry import registry_root
        return session, {"ok": True, "runs": [json.loads(p.read_text()) for p in registry_root().glob('run-*.json')]}
    if op == "labCatalog":
        from .gallery import catalog

        return session, {"ok": True, "games": catalog()}
    if op == "labGet":
        from .gallery import GALLERY

        gid = str(msg["id"])
        if gid not in GALLERY:
            return session, {"ok": False, "error": f"unknown game {gid!r}"}
        e = GALLERY[gid]
        spec = e.spec()
        return session, {
            "ok": True,
            "game": {
                "id": gid,
                "title": e.title,
                "blurb": e.blurb,
                "tags": e.tags,
                "specHash": __import__("hashlib").sha256(
                    __import__("json").dumps(spec, sort_keys=True).encode()
                ).hexdigest(),
                "mutations": e.mutations,
            },
        }
    if op == "labVariant":
        import json as _json

        from .gallery import GALLERY
        from .gamespec_ir import ir_hash

        gid = str(msg["id"])
        params = dict(msg.get("params") or {})
        try:
            spec = GALLERY[gid].variant(**params)
            doc = load_ir(spec)
            return session, {"ok": True, "spec": spec,
                             "specHash": ir_hash(doc)}
        except Exception as e:  # noqa: BLE001 — protocol boundary
            return session, {"ok": False, "error": str(e)}
    if op == "labSimulate":
        from .lab import simulate

        try:
            stats = simulate(dict(msg["spec"]),
                             list(msg.get("agents", [])),
                             int(msg["episodes"]),
                             int(msg.get("seed", 42)))
            return session, {"ok": True, "stats": stats}
        except Exception as e:  # noqa: BLE001 — protocol boundary
            return session, {"ok": False, "error": str(e)}
    if op == "labSolve":
        from .solver_agents import choose_agent_for_game, solve_game_cfr

        try:
            spec = dict(msg["spec"])
            sol = solve_game_cfr(spec, int(msg.get("iterations", 300)))
            return session, {"ok": True,
                             "recommended": choose_agent_for_game(spec),
                             **{k: v for k, v in sol.items() if k != "policy"},
                             "strategy": sol["policy"]}
        except Exception as e:  # noqa: BLE001
            return session, {"ok": False, "error": str(e)}
    if op == "labStrategy":
        from .solver_agents import CFRAgent

        try:
            agent = CFRAgent(dict(msg["spec"]), int(msg.get("iterations", 300)))
            legal, probs = agent.probs_for(str(msg["infoState"]))
            return session, {"ok": True,
                             "actions": legal, "probs": probs,
                             "meta": agent.meta}
        except Exception as e:  # noqa: BLE001
            return session, {"ok": False, "error": str(e)}
    if op == "labStrategySamples":
        from .solver_agents import CFRAgent

        try:
            agent = CFRAgent(dict(msg["spec"]), int(msg.get("iterations", 300)))
            return session, {"ok": True,
                             "samples": agent.sample_strategy(int(msg.get("k", 4))),
                             "meta": agent.meta}
        except Exception as e:  # noqa: BLE001
            return session, {"ok": False, "error": str(e)}
    if op == "labRecommend":
        from .solver_agents import choose_agent_for_game

        return session, {"ok": True,
                         "agent": choose_agent_for_game(dict(msg["spec"]))}
    if op == "aiChoose":
        """Pick an action for the CURRENT actor of the live session (§9).

        Runs entirely on information available to the actor — never reveals
        hidden zones to anyone else.
        """
        from .solver_agents import CFRAgent

        try:
            kind = str(msg.get("agent", "random"))
            st = session.state
            if st.is_terminal():
                return session, {"ok": False, "error": "game over"}
            if st.is_chance_node():
                outs = st.chance_outcomes()
                import random as _r

                pick = _r.Random(msg.get("seed", 0)).choices(
                    [a for a, _ in outs], weights=[p for _, p in outs])[0]
                st.apply_action(pick)
                session._resolve_chance()
                return session, {"ok": True, "chanceApplied": True}
            player = st.current_player()
            info = st.information_state_string(player)
            legal = sorted(st.legal_actions(player))
            if kind == 'cfr':
                from .solver_agents import choose_agent_for_game
                if 'chosenKind' not in session._agents:
                    session._agents['chosenKind'] = choose_agent_for_game(session.ir)
                kind = session._agents['chosenKind']
            if kind.startswith('checkpoint:'):
                from .checkpoint_registry import load_checkpoint
                from .selfplay import render_policy_input
                checkpoint = session._agents.get(kind)
                if checkpoint is None:
                    checkpoint = load_checkpoint(kind.split(':', 1)[1])
                    session._agents[kind] = checkpoint
                prompt, candidates = render_policy_input(json.dumps(session.ir, sort_keys=True, separators=(',', ':')), st, player)
                selected = checkpoint.sample(prompt, [c['candidateId'] for c in candidates])
                pick = next(c['environmentActionId'] for c in candidates if c['candidateId'] == selected)
            elif kind == "cfr":
                agent = session._agents.get("cfr")
                if agent is None:
                    agent = CFRAgent(session.ir, int(msg.get("iterations", 300)), seed=session._rng.randrange(2**31))
                    session._agents["cfr"] = agent
                agent.rng = session._rng
                pick = agent.act(info, legal)
            elif kind == "random":
                import random as _r

                pick = session._rng.choice(legal)
            else:
                return session, {"ok": False, "error": f"unknown agent {kind}"}
            return session, {"ok": True, "player": player,
                             "action": int(pick), "infoState": info}
        except Exception as e:  # noqa: BLE001
            return session, {"ok": False, "error": str(e)}
    if op == "labShare":
        """Resolve a gallery variant and persist a share record keyed by
        {galleryId}-{specHash8}; the spec itself stays pure data (§38)."""
        import hashlib
        import json as _json
        import os

        from .gallery import GALLERY
        from .gamespec_ir import ir_hash

        gid = str(msg.get("galleryId") or "")
        params = dict(msg.get("params") or {})
        try:
            if gid:
                spec = GALLERY[gid].variant(**params)
                title = GALLERY[gid].title
            else:
                # Inline custom spec (e.g. freshly compiled): stored as pure
                # data like any other share record.
                if msg.get("compileJobId"):
                    from .compile_jobs import read_job
                    accepted = read_job(msg["compileJobId"])
                    if accepted["status"] != "ready":
                        raise ValueError("game revision has not been accepted")
                    spec = accepted["spec"]
                else:
                    spec = dict(msg["spec"])
                    from .compiler import _semantic_smoke
                    smoke = _semantic_smoke(spec)
                    if smoke["reached_terminal"] != smoke["episodes"]:
                        raise ValueError("game failed validation")
                title = str(spec.get("title") or "Custom game")
            doc = load_ir(spec)
            h = ir_hash(doc)
            share_id = f"{gid or 'custom'}-{h[:8]}"
            rec = {"schemaVersion": 1, "specHash": h, "title": title}
            if gid:
                rec.update({"galleryId": gid, "params": params})
            else:
                rec["spec"] = doc
                rec["runtimeVersion"] = RUNTIME_VERSION
            root = os.environ.get(
                "RULEZERO_SHARES",
                os.path.join(os.path.dirname(os.path.dirname(
                    os.path.abspath(__file__))), "reports", "shared"))
            os.makedirs(root, exist_ok=True)
            path = os.path.join(root, f"{share_id}.json")
            tmp = path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(rec, f, sort_keys=True)
            os.replace(tmp, path)
            return session, {"ok": True, "shareId": share_id,
                             "specHash": h,
                             "digest": hashlib.sha256(path.encode()).hexdigest()[:12]}
        except Exception as e:  # noqa: BLE001
            return session, {"ok": False, "error": str(e)}
    if op == "labResolveShared":
        import json as _json
        import os

        from .gamespec_ir import ir_hash

        share_id = str(msg["shareId"])
        if not all(c.isalnum() or c in "-_" for c in share_id):
            return session, {"ok": False, "error": "bad share id"}
        root = os.environ.get(
            "RULEZERO_SHARES",
            os.path.join(os.path.dirname(os.path.dirname(
                os.path.abspath(__file__))), "reports", "shared"))
        path = os.path.join(root, f"{share_id}.json")
        if not os.path.exists(path):
            return session, {"ok": False, "error": "unknown share"}
        try:
            rec = _json.load(open(path))
            if "spec" in rec:
                spec = rec["spec"]
            elif "galleryId" in rec:
                from .gallery import GALLERY

                spec = GALLERY[rec["galleryId"]].variant(**rec.get("params") or {})
            else:
                spec = rec["spec"]
            doc = load_ir(spec)
            h = ir_hash(doc)
            if h != rec["specHash"]:
                return session, {"ok": False, "error": "spec drift"}
            return session, {"ok": True, "spec": spec, "specHash": h,
                             "title": rec.get("title"),
                             "params": rec.get("params") or {}}
        except Exception as e:  # noqa: BLE001
            return session, {"ok": False, "error": str(e)}
    if op == "labReview":
        """Compare logged decisions against the CFR reference (S14).
        Uses only actor-visible info states."""
        from .solver_agents import CFRAgent

        try:
            agent = CFRAgent(session.ir, int(msg.get("iterations", 300)))
            out = []
            for i, d in enumerate(session.review_log):
                legal, probs = agent.probs_for(d["infoState"])
                by_id = dict(zip(legal, probs))
                scored = sorted(
                    ((c["label"], float(by_id.get(
                        c["environmentActionId"], 0.0)))
                     for c in d["candidates"]),
                    key=lambda kv: kv[1], reverse=True)
                chosen = next((c for c in d["candidates"]
                               if c["environmentActionId"]
                               == d.get("chosenAction")), None)
                out.append({
                    "step": i,
                    "player": d["player"],
                    "chosen": (chosen or {}).get("label"),
                    "referenceTop": (scored[0][0], round(scored[0][1], 3))
                    if scored else None,
                    "distribution": [(lb, round(pr, 3))
                                     for lb, pr in scored],
                })
            return session, {"ok": True,
                             "nashConv": agent.meta.get("nashConv"),
                             "review": out}
        except Exception as e:  # noqa: BLE001
            return session, {"ok": False, "error": str(e)}
    if op in ("labCompile", "labCompileStart", "labJobGet", "labCompileRevise", "labCompileAccept", "labSimulateStart", "labTrainStart", "labJobCancel"):
        from .compile_jobs import LabJobs, read_job, accept
        global _JOBS
        if _JOBS is None:
            _JOBS = LabJobs()
        if op == "labTrainStart":
            return session, {"ok": True, "job": _JOBS.submit("training", msg.get("config", {}))}
        if op == "labJobCancel":
            from .compile_jobs import save_job
            job = read_job(msg["id"]); job["cancelRequested"] = True; save_job(job)
            return session, {"ok": True, "job": job}
        if op == "labJobGet":
            return session, {"ok": True, "job": read_job(msg["id"])}
        if op == "labCompileAccept":
            return session, {"ok": True, "job": accept(msg["id"], msg.get("acknowledged") is True)}
        if op == "labSimulateStart":
            payload = {"spec": msg["spec"], "agent_specs": msg["agents"],
                       "episodes": min(2000, max(1, int(msg.get("episodes", 100)))), "seed": int(msg.get("seed", 42))}
            return session, {"ok": True, "job": _JOBS.submit("simulate", payload)}
        from .compiler_backend import compiler_is_configured
        if not compiler_is_configured():
            return session, {"ok": False, "error": "Compiler unavailable: configure RULEZERO_COMPILER_URL and RULEZERO_COMPILER_MODEL, or set OPENCODE_API_KEY for OpenCode Go"}
        payload = {"text": str(msg.get("text", "")), "answers": msg.get("answers", {})}
        if op == "labCompileRevise":
            previous = read_job(msg["id"])
            payload["text"] = msg.get("text") or previous["payload"]["text"]
            payload["answers"] = {**previous["payload"].get("answers", {}), **payload["answers"]}
            payload["priorHistory"] = previous.get("history", [])
            payload["diagnostics"] = previous.get("diagnostics", [])
        if not 1 <= len(payload["text"].strip()) <= 16000:
            raise ValueError("Rules must contain 1..16000 characters")
        return session, {"ok": True, "job": _JOBS.submit("compile", payload, msg.get("id"))}
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
                else st.legal_actions(msg.get("player", -1))
            return session, {"ok": True, "actions": acts}
        if op == "apply":
            return session, session.apply(msg)
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
            try:
                _SESSION, resp = handle(_SESSION, msg)
            except Exception as e:
                resp = {"ok": False, "error": str(e)}
            if "requestId" in msg:
                resp["requestId"] = msg["requestId"]
        stdout.write(json.dumps(resp) + "\n")
        stdout.flush()


_SESSION: Session | None = None
_JOBS = None


if __name__ == "__main__":
    serve()
