"""Generic GameSpec IR interpreter → OpenSpiel (Phase-2 §9/§32).

ONE runtime for every IR spec. The spec is data; this module interprets it.
No generated Python, no embedded code execution.

Semantics
---------
- Chance phases expand into sequential uniform draw-without-replacement nodes:
  chance_outcomes() = remaining contents of the source zone; apply_action
  consumes exactly that card. States hold NO RNG anywhere.
- Decision phases expose the spec's actions filtered by preconditions;
  effects run deterministically on application.
- Reaction phases open an explicit reaction window (deterministic seat-order
  priority, one decision per eligible actor) — generic §5 machinery.
- award phases transfer score/pot vars between players by comparison or fixed
  rule; terminal phases end the game with returns = score - mean (zero-sum).
- Zone visibility drives observations: owner zones show contents only to the
  owner, hidden zones only counts, public zones to everyone.

Zone expressions in effects/scoring: "deck", "prizes", "hand@p" (= actor),
"hand@other", "hand0" (fixed seat), "@actor"/"@p"/"@i" bind at runtime.
"""

from __future__ import annotations

import pyspiel

from .gamespec_ir import ir_hash, load_ir


def _resolve(ref: str, actor: int | None, n: int) -> str:
    if "@" not in ref:
        return ref
    base, tag = ref.split("@", 1)
    if tag in ("p", "i", "actor"):
        who = actor if actor is not None else 0
    elif tag == "other":
        who = ((actor + 1) % n) if actor is not None else 1
    else:
        who = int(tag)
    return f"{base}{who}"


class IRState(pyspiel.State):

    def __init__(self, game):
        super().__init__(game)
        self.ir = game.ir
        self.n = game.num_players()
        ents = self.ir.get("entities", {})
        deck: list[int] = []
        for r in sorted(ents.get("cardRanks", [])):
            deck += [r] * int(ents.get("copiesPerRank", 1))
        self.zones: dict[str, list[int]] = {"deck": deck}
        self.zone_vis: dict[str, str] = {"deck": "hidden"}
        for z in self.ir.get("zones", []):
            vis, zid = z["visibility"], z["id"]
            self.zone_vis[zid] = vis
            if z.get("perPlayer"):
                for p in range(self.n):
                    pid = f"{zid}{p}"
                    self.zones[pid] = []
                    self.zone_vis[pid] = vis
            elif zid != "deck":
                self.zones[zid] = []
        self.vars: dict[str, float] = {v["id"]: v.get("init", 0)
                                       for v in self.ir.get("vars", [])}
        self.phase_idx = 0
        self.actor = None
        self.rotate_ptr = 0
        self.last_actor = None
        self.chance_actor = 0
        self.chance_left = 0
        self.window = None  # {"queue": tuple, "i": int, "resume": phase_idx}
        self._enter_phase(0)

    # ---------- phase machine --------------------------------------------
    def _phase(self):
        return self.ir["phases"][self.phase_idx]

    def _enter_phase(self, idx: int):
        self.phase_idx = idx
        ph = self._phase()
        kind = ph["kind"]
        if kind == "chance":
            ch = ph["chance"]
            self.chance_actor = 0
            reps = self.n if ch.get("roundRobin", True) else 1
            self.chance_left = int(ch.get("count", 1)) * reps
            return
        if kind == "decision":
            dec = ph["decision"]
            if dec.get("actor") == "rotate":
                self.actor = self.rotate_ptr % self.n
                self.rotate_ptr += 1
            else:
                self.actor = int(dec["actor"])
            return
        if kind == "reaction":
            after = (self.last_actor + 1) if self.last_actor is not None else 1
            queue = tuple(sorted({(after + k) % self.n
                                  for k in range(self.n)}))
            if queue:
                self.window = {"queue": queue, "i": 0, "resume": idx}
                self.actor = queue[0]
            else:
                self._goto(ph.get("goto"))
            return
        if kind == "award":
            self._run_award(ph)
            return
        # terminal: nothing to do

    def _goto(self, target: str | None):
        if target is None:
            nxt = self.phase_idx + 1
            if nxt >= len(self.ir["phases"]):
                raise RuntimeError(
                    f"spec {self.ir['name']}: flow fell off phase list "
                    f"without terminal")
            self._enter_phase(nxt)
        else:
            ids = [p["id"] for p in self.ir["phases"]]
            self._enter_phase(ids.index(target))

    def _zone_sum(self, expr):
        if isinstance(expr, (int, float)):
            return float(expr)
        if isinstance(expr, dict) and "sumRank" in expr:
            ref = _resolve(expr["sumRank"], self.actor, self.n)
            return float(sum(self.zones[ref]))
        raise ValueError(f"bad expression {expr!r}")

    def _run_effects(self, actor: int, effects: list[dict]):
        self.last_actor = actor
        jump = None
        for eff in effects or []:
            op = eff["op"]
            if op == "incr":
                self.vars[eff["var"]] += eff["by"]
            elif op == "dec":
                self.vars[eff["var"]] -= eff["by"]
            elif op == "set":
                self.vars[eff["var"]] = self._zone_sum(eff["value"])
            elif op == "move":
                src = _resolve(eff["from"], actor, self.n)
                dst = _resolve(eff["to"], actor, self.n)
                rank = eff.get("rank")
                for _ in range(int(eff.get("n", 1))):
                    if rank is not None:
                        if rank in self.zones[src]:
                            self.zones[src].remove(rank)
                            self.zones[dst].append(rank)
                    elif self.zones[src]:
                        self.zones[dst].append(self.zones[src].pop(0))
            elif op == "reveal":
                zid = _resolve(eff["zone"], actor, self.n)
                self.zone_vis[zid] = "public"
            elif op == "clear":
                self.zones[_resolve(eff["zone"], actor, self.n)] = []
            elif op == "compareGoto":
                a, b = self._zone_sum(eff["a"]), self._zone_sum(eff["b"])
                key = "gt" if a > b else ("lt" if a < b else "eq")
                if eff.get(key):
                    jump = eff[key]
        return jump

    def _run_award(self, ph):
        aw = ph["award"]
        amount = (float(self.vars.pop(aw["amountVar"]))
                  if aw.get("amountVar") else float(aw.get("amount", 0)))
        mode, winner = aw["to"], None
        if mode == "compareZones":
            a, b = self._zone_sum(aw["a"]), self._zone_sum(aw["b"])
            winner = None if a == b else (0 if a > b else 1)
            if winner is None and aw.get("tieSplit"):
                for p in range(self.n):
                    self.vars[f"score{p}"] += amount / self.n
                amount = 0.0
        elif mode == "lastActor":
            winner = self.last_actor
        elif mode == "otherOfLast":
            winner = (((self.last_actor or 0) + 1) % self.n)
        elif mode == "splitAll":
            for p in range(self.n):
                self.vars[f"score{p}"] += amount / self.n
            self._goto(ph.get("goto"))
            return
        if winner is not None:
            self.vars[f"score{winner}"] += amount
        # NOTE: goto is nested inside the award sub-object.
        self._goto(aw.get("goto"))

    # ---------- OpenSpiel interface ----------------------------------------
    def is_chance_node(self):
        ph = self._phase()
        if ph["kind"] != "chance" or self.chance_left <= 0:
            return False
        src = _resolve(ph["chance"]["from"],
                       self.chance_actor if ph["chance"].get("roundRobin", True)
                       else 0, self.n)
        return bool(self.zones[src])

    def chance_outcomes(self):
        assert self.is_chance_node()
        ph = self._phase()
        src = _resolve(ph["chance"]["from"],
                       self.chance_actor if ph["chance"].get("roundRobin", True)
                       else 0, self.n)
        cards = sorted(set(self.zones[src]))
        p = 1.0 / len(cards)
        return [(c, p) for c in cards]

    def current_player(self):
        if self.is_terminal():
            return pyspiel.PlayerId.TERMINAL
        if self.is_chance_node():
            return pyspiel.PlayerId.CHANCE
        return self.actor if self.actor is not None else 0

    def _action_table(self):
        ph = self._phase()
        if ph["kind"] == "reaction":
            return [a["id"] for a in ph["reaction"]["actions"]]
        out = []
        for a in ph.get("decision", {}).get("actions", []):
            if self._action_allowed(a):
                out.append(a["id"])
        return out

    def _action_allowed(self, a: dict) -> bool:
        req = a.get("requires")
        if req is None:
            return True
        if "var" in req:
            return self.vars.get(req["var"]) == req.get("eq")
        cih = req.get("cardInHand")
        if cih is not None:
            zid = _resolve(cih["zone"], self.actor, self.n)
            return cih["rank"] in self.zones[zid]
        return True

    def legal_actions(self, player):
        if self.is_terminal() or self.is_chance_node():
            return []
        if player != self.current_player():
            return []
        return list(range(len(self._action_table())))

    def apply_action(self, action: int):
        if self.is_chance_node():
            ph = self._phase()
            ch = ph["chance"]
            rr = ch.get("roundRobin", True)
            who = self.chance_actor if rr else 0
            src = _resolve(ch["from"], who, self.n)
            card = int(action)
            if card not in self.zones[src]:
                raise ValueError(f"chance card {card} not in {src}")
            self.zones[src].remove(card)
            self.zones[_resolve(ch["to"], who, self.n)].append(card)
            self.chance_left -= 1
            if rr:
                self.chance_actor = (who + 1) % self.n
            if self.chance_left == 0:
                self.last_actor = None
                self._goto(ph.get("goto"))
            return

        if self.is_terminal():
            raise ValueError("no actions at terminal")
        table = self._action_table()
        if not 0 <= action < len(table):
            raise ValueError(f"illegal action {action} for table {table}")
        aid = table[action]
        actor = self.current_player()
        ph = self._phase()

        if ph["kind"] == "reaction":
            act_def = next(a for a in ph["reaction"]["actions"]
                           if a["id"] == aid)
            w = self.window
            self.window = None
            jump = self._run_effects(actor, act_def.get("effects"))
            if act_def.get("endsWindow") or jump or w["i"] + 1 >= len(w["queue"]):
                self._goto(jump or act_def.get("goto") or ph.get("goto"))
            else:
                self.window = {"queue": w["queue"], "i": w["i"] + 1,
                               "resume": w["resume"]}
                self.actor = w["queue"][w["i"] + 1]
            return

        act_def = next(a for a in ph["decision"]["actions"] if a["id"] == aid)
        jump = self._run_effects(actor, act_def.get("effects"))
        self._goto(jump if jump else act_def.get("goto"))

    def is_terminal(self):
        return self._phase()["kind"] == "terminal"

    def returns(self):
        scores = [self.vars.get(f"score{p}", 0.0) for p in range(self.n)]
        mean = sum(scores) / self.n
        return [s - mean for s in scores]

    def __str__(self):
        zs = ",".join(f"{k}:{len(v)}" for k, v in sorted(self.zones.items()))
        vs = ",".join(f"{k}={v}" for k, v in sorted(self.vars.items()))
        return (f"IR({self.ir['name']}) {self._phase()['id']} "
                f"actor={self.actor} zones[{zs}] vars[{vs}]")

    def observation_string(self, player: int):
        parts = [f"phase={self._phase()['id']}"]
        for zid in sorted(self.zones):
            vis = self.zone_vis[zid]
            cards = self.zones[zid]
            if vis == "public":
                parts.append(f"{zid}={cards}")
            elif vis == "owner":
                digits = ''.join(c for c in zid if c.isdigit())
                mine = digits == str(player)
                parts.append(f"{zid}=" +
                             (str(cards) if mine else f"hidden({len(cards)})"))
            else:
                parts.append(f"{zid}=hidden({len(cards)})")
        vs = ",".join(f"{k}={v}" for k, v in sorted(self.vars.items()))
        parts.append(f"vars[{vs}]")
        return " ".join(parts)

    def information_state_string(self, player: int):
        hist = "".join(f"p{_p}:{a} " for _p, a in self.history()
                       if isinstance(_p, int))
        return f"[p{player}] {self.observation_string(player)} hist={hist}"

    def action_to_string(self, player, action):
        try:
            return f"A{action}:{self._action_table()[action]}"
        except Exception:
            return f"A{action}:?"

    def clone(self):
        st = IRState(self.__game())
        st.zones = {k: list(v) for k, v in self.zones.items()}
        st.zone_vis = dict(self.zone_vis)
        st.vars = dict(self.vars)
        st.phase_idx = self.phase_idx
        st.actor = self.actor
        st.rotate_ptr = self.rotate_ptr
        st.last_actor = self.last_actor
        st.chance_actor = self.chance_actor
        st.chance_left = self.chance_left
        st.window = None if self.window is None else {
            "queue": tuple(self.window["queue"]), "i": self.window["i"],
            "resume": self.window["resume"]}
        return st

    def __game(self):
        return self.get_game()


class IRGame(pyspiel.Game):
    """OpenSpiel game for ANY validated IR spec — one class, data-driven."""

    def __init__(self, ir_doc: dict):
        self.ir = load_ir(ir_doc)
        self._n = int(self.ir["players"]["count"])
        params = {"spec_name": str(self.ir["name"])}
        game_type = pyspiel.GameType(
            short_name="ir_" + self.ir["name"],
            long_name=f"GameSpec IR: {self.ir['name']}",
            dynamics=pyspiel.GameType.Dynamics.SEQUENTIAL,
            chance_mode=pyspiel.GameType.ChanceMode.EXPLICIT_STOCHASTIC,
            information=pyspiel.GameType.Information.IMPERFECT_INFORMATION,
            utility=pyspiel.GameType.Utility.ZERO_SUM,
            reward_model=pyspiel.GameType.RewardModel.TERMINAL,
            max_num_players=6,
            min_num_players=2,
            provides_information_state_string=True,
            provides_information_state_tensor=False,
            provides_observation_string=True,
            provides_observation_tensor=False,
            parameter_specification={"spec_name": ""},
        )
        ranks = self.ir.get("entities", {}).get("cardRanks", [2])
        game_info = pyspiel.GameInfo(
            num_distinct_actions=16,
            max_chance_outcomes=max(2, len(ranks)),
            num_players=self._n,
            min_utility=-10000.0,
            max_utility=10000.0,
            utility_sum=0.0,
            max_game_length=512,
        )
        super().__init__(game_type, game_info, params)

    def num_players(self):
        return self._n

    def max_game_length(self):
        return 512

    def new_initial_state(self, seed: int | None = None):
        # seed accepted for API compatibility; states hold no RNG.
        return IRState(self)


def compile_ir(doc: dict) -> tuple[IRGame, str]:
    """Validate → instantiate. Returns (game, sha256)."""
    return IRGame(doc), ir_hash(doc)
