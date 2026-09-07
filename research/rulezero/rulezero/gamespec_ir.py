"""GameSpec v1 IR — data-only game language subset (Phase-2 §10/§11).

This is a REAL intermediate representation, not a bag of knobs: entities,
visibility-tagged zones, state variables, a phase machine (chance / decision
/ reaction-window / award / terminal phases), action preconditions and
effects. The runtime (gamespec_runtime) interprets this data. No Python,
no JS, no codegen — every spec is canonical JSON hashed with SHA-256.

Vocabulary intentionally mirrors §10 names so later expansion is additive:
entities, zones(+visibility), vars, phases(chance|decision|reaction|award|
terminal), actions(preconditions/effects), effects(move|set|incr|reveal|
compareGoto|award), termination, scoring.

Effect op reference (v1):
  {"op":"incr","var":V,"by":N}            add N to var V
  {"op":"dec","var":V,"by":N}             subtract N from var V
  {"op":"set","var":V,"value":E}          E = number | {"sumRank":zoneExpr}
  {"op":"move","from":Z,"to":Z2,"n":K}    move K cards (top) Z -> Z2
  {"op":"reveal","zone":Z}                zone becomes public knowledge
  {"op":"revealVar","var":V}              variable becomes public knowledge
  {"op":"compareGoto","a":A,"b":B,
   "gt":P,"lt":P,"eq":P}                  compare rank sums, jump phases
Zone expressions: "deck", "prizes", "hand@p", "won@i", "@actor", "@other",
"pot" (var). "@p"/"@i" bind to the acting player index at execution time.
"""

from __future__ import annotations

import hashlib
import json
import math
import re

_PHASE_KINDS = {"chance", "decision", "reaction", "award", "terminal"}
_VIS = {"hidden", "owner", "public"}
_OPS = {"incr", "dec", "set", "move", "reveal", "clear",
        "revealVar", "compareGoto"}
_ACTOR_SPECS = {"allOthersAfterLastActor", "rotate"}


class IRValidationError(ValueError):
    pass


def _err(msg):  # raise helper keeping validate() readable
    raise IRValidationError(msg)


def _validate_ir(doc: dict) -> list[str]:
    """Static validation (§11 subset). Returns [] or raises with all problems."""
    errs: list[str] = []

    def need(cond, msg):
        if not cond:
            errs.append(msg)

    need(doc.get("schemaVersion") == 1, "schemaVersion must be 1")
    need(isinstance(doc.get("name"), str) and doc["name"], "name required")
    n_players = doc.get("players", {}).get("count")
    need(isinstance(n_players, int) and 2 <= n_players <= 6,
         "players.count in [2,6]")

    ents = doc.get("entities", {})
    ranks = ents.get("cardRanks")
    need(isinstance(ranks, list) and len(set(ranks)) == len(ranks) >= 2,
         "entities.cardRanks needs >=2 unique ranks")

    zone_ids: set[str] = set()
    per_player: set[str] = set()
    for z in doc.get("zones", []):
        zid = z.get("id")
        need(isinstance(zid, str) and zid and zid not in zone_ids,
             f"zone id invalid/duplicate: {zid!r}")
        zone_ids.add(zid)
        need(z.get("visibility") in _VIS,
             f"zone {zid}: visibility must be one of {_VIS}")
        if z.get("perPlayer"):
            per_player.add(zid)
            for pi in range(int(doc.get("players", {}).get("count", 2))):
                zone_ids.add(f"{zid}{pi}")

    var_ids = {v.get("id") for v in doc.get("vars", [])}

    phase_ids: set[str] = set()
    for ph in doc.get("phases", []):
        pid = ph.get("id")
        need(isinstance(pid, str) and pid and pid not in phase_ids,
             f"phase id invalid/duplicate: {pid!r}")
        phase_ids.add(pid)
    need(len(phase_ids) > 0, "spec has no phases")

    def zone_ref_ok(ref: str) -> bool:
        base = ref.split("@")[0]
        return base in zone_ids or base in var_ids

    def expr_ok(e) -> bool:
        if isinstance(e, (int, float)):
            return True
        if isinstance(e, dict) and "sumRank" in e:
            return zone_ref_ok(e["sumRank"])
        return False

    def check_goto(g):
        if g is None:
            return
        need(isinstance(g, str) and g in phase_ids,
             f"goto target undefined: {g!r}")

    for ph in doc.get("phases", []):
        pid = ph.get("id")
        kind = ph.get("kind")
        need(kind in _PHASE_KINDS, f"phase {pid}: unknown kind {kind!r}")
        if kind == "chance":
            ch = ph.get("chance", {})
            need(zone_ref_ok(ch.get("from", "")) and zone_ref_ok(ch.get("to", "")),
                 f"phase {pid}: chance zones undefined")
            need(isinstance(ch.get("count", 0), int) and ch["count"] >= 1,
                 f"phase {pid}: chance.count >= 1 required")
        elif kind == "decision":
            dec = ph.get("decision", {})
            actor = dec.get("actor")
            need(actor == "rotate" or isinstance(actor, int),
                 f"phase {pid}: decision.actor must be seat int or 'rotate'")
            acts = dec.get("actions", [])
            need(isinstance(acts, list) and acts, f"phase {pid}: no actions")
            ids_seen = set()
            for a in acts:
                aid = a.get("id")
                need(isinstance(aid, str) and aid and aid not in ids_seen,
                     f"phase {pid}: bad/duplicate action id {aid!r}")
                ids_seen.add(aid)
                req = a.get("requires")
                if req is not None and "cardInHand" in req:
                    cih = req["cardInHand"]
                    need(zone_ref_ok(cih.get("zone", "")),
                         f"phase {pid}/{aid}: cardInHand.zone undefined")
                    need(isinstance(cih.get("rank"), int),
                         f"phase {pid}/{aid}: cardInHand.rank must be int")
                elif req is not None:
                    need("var" in req,
                         f"phase {pid}/{aid}: requires needs var or cardInHand")
                for eff in a.get("effects", []):
                    need(eff.get("op") in _OPS,
                         f"phase {pid}/{aid}: unknown op {eff.get('op')!r}")
                    if eff["op"] == "move" and eff.get("rank") is not None:
                        need(isinstance(eff["rank"], int),
                             f"phase {pid}/{aid}: move.rank must be int")
                    if eff["op"] in ("incr", "dec"):
                        need(eff.get("var") in var_ids,
                             f"phase {pid}/{aid}: var undefined")
                        need(isinstance(eff.get("by"), (int, float)),
                             f"phase {pid}/{aid}: numeric 'by' required")
                    elif eff["op"] == "set":
                        need(eff.get("var") in var_ids,
                             f"phase {pid}/{aid}: var undefined")
                        need(expr_ok(eff.get("value")),
                             f"phase {pid}/{aid}: bad set value")
                    elif eff["op"] == "move":
                        need(zone_ref_ok(eff.get("from", ""))
                             and zone_ref_ok(eff.get("to", "")),
                             f"phase {pid}/{aid}: move zones undefined")
                        need(isinstance(eff.get("n", 1), int),
                             f"phase {pid}/{aid}: move.n must be int")
                    elif eff["op"] == "reveal":
                        need(zone_ref_ok(eff.get("zone", "")),
                             f"phase {pid}/{aid}: reveal zone undefined")
                    elif eff["op"] == "revealVar":
                        need(eff.get("var") in var_ids,
                             f"phase {pid}/{aid}: var undefined")
                    elif eff["op"] == "clear":
                        need(zone_ref_ok(eff.get("zone", "")),
                             f"phase {pid}/{aid}: clear zone undefined")
                    elif eff["op"] == "compareGoto":
                        need(expr_ok(eff.get("a")) and expr_ok(eff.get("b")),
                             f"phase {pid}/{aid}: compare operands invalid")
                        for g in (eff.get("gt"), eff.get("lt"), eff.get("eq")):
                            check_goto(g)
                check_goto(a.get("goto"))
        elif kind == "reaction":
            rx = ph.get("reaction", {})
            need(rx.get("actors") in _ACTOR_SPECS,
                 f"phase {pid}: reaction.actors unsupported")
            need(rx.get("priority", "seatOrder") == "seatOrder",
                 f"phase {pid}: only seatOrder priority defined in v1")
            acts = rx.get("actions", [])
            need(bool(acts), f"phase {pid}: reaction needs actions")
            ids_seen = set()
            for a in acts:
                aid = a.get("id")
                need(isinstance(aid, str) and aid and aid not in ids_seen,
                     f"phase {pid}: bad/duplicate action id {aid!r}")
                ids_seen.add(aid)
                req = a.get("requires")
                if req is not None and "cardInHand" in req:
                    cih = req["cardInHand"]
                    need(zone_ref_ok(cih.get("zone", "")),
                         f"phase {pid}/{aid}: cardInHand.zone undefined")
                    need(isinstance(cih.get("rank"), int),
                         f"phase {pid}/{aid}: cardInHand.rank must be int")
                elif req is not None:
                    need("var" in req,
                         f"phase {pid}/{aid}: requires needs var or cardInHand")
                for eff in a.get("effects", []):
                    need(eff.get("op") in _OPS,
                         f"phase {pid}/{aid}: unknown op {eff.get('op')!r}")
                    if eff.get("op") in ("incr", "dec"):
                        need(eff.get("var") in var_ids,
                             f"phase {pid}/{aid}: var undefined")
                        need(isinstance(eff.get("by"), (int, float)),
                             f"phase {pid}/{aid}: numeric 'by' required")
                    elif eff.get("op") == "set":
                        need(eff.get("var") in var_ids,
                             f"phase {pid}/{aid}: var undefined")
                        need(expr_ok(eff.get("value")),
                             f"phase {pid}/{aid}: bad set value")
                    elif eff.get("op") == "move":
                        need(zone_ref_ok(eff.get("from", "")) and zone_ref_ok(eff.get("to", "")),
                             f"phase {pid}/{aid}: move zones undefined")
                        need(isinstance(eff.get("n", 1), int),
                             f"phase {pid}/{aid}: move.n must be int")
                    elif eff.get("op") in ("reveal", "clear"):
                        need(zone_ref_ok(eff.get("zone", "")),
                             f"phase {pid}/{aid}: zone undefined")
                    elif eff.get("op") == "revealVar":
                        need(eff.get("var") in var_ids,
                             f"phase {pid}/{aid}: var undefined")
                    elif eff.get("op") == "compareGoto":
                        need(expr_ok(eff.get("a")) and expr_ok(eff.get("b")),
                             f"phase {pid}/{aid}: compare operands invalid")
                        for g in (eff.get("gt"), eff.get("lt"), eff.get("eq")):
                            check_goto(g)
                check_goto(a.get("goto"))
        elif kind == "award":
            aw = ph.get("award", {})
            need(aw.get("to") in ("compareZones", "lastActor", "otherOfLast",
                                  "splitAll"),
                 f"phase {pid}: award.to unsupported")
            need(aw.get("amountVar") in var_ids or isinstance(
                aw.get("amount"), (int, float)),
                f"phase {pid}: award needs amountVar or amount")
        # terminal phases carry no extra structure

    terms = [p for p in doc.get("phases", []) if p.get("kind") == "terminal"]
    need(len(terms) >= 1, "spec lacks any terminal phase (§11)")

    # ---- reachability: every phase must be reachable from phase 0 --------
    # Edges: fallthrough (i -> i+1) plus every declared goto target.
    ids = [ph["id"] for ph in doc.get("phases", [])]
    adj: dict[int, set[int]] = {}
    for i, ph in enumerate(doc.get("phases", [])):
        edges: set[int] = set()
        if i + 1 < len(ids):
            edges.add(i + 1)
        def add_goto(g):
            if isinstance(g, str) and g in ids:
                edges.add(ids.index(g))
        add_goto(ph.get("goto"))
        if ph.get("kind") == "award":
            # award gotos live inside the award sub-object (runtime parity).
            add_goto(ph.get("award", {}).get("goto"))
        if ph.get("kind") == "decision":
            for a in ph["decision"].get("actions", []):
                add_goto(a.get("goto"))
                for eff in a.get("effects", []):
                    if eff.get("op") == "compareGoto":
                        for g in (eff.get("gt"), eff.get("lt"), eff.get("eq")):
                            add_goto(g)
        elif ph.get("kind") == "reaction":
            for a in ph["reaction"].get("actions", []):
                add_goto(a.get("goto"))
        adj[i] = edges
    seen: set[int] = set()
    stack = [0]
    while stack:
        i = stack.pop()
        if i in seen:
            continue
        seen.add(i)
        stack.extend(adj[i] - seen)
    for i, ph in enumerate(doc.get("phases", [])):
        if i not in seen:
            errs.append(f"phase {ph['id']}: unreachable from entry")

    # ---- no-progress loops: a reachable cycle containing NO phase kind
    # that consumes player/chance input can spin forever --------------------
    KINDS_PROGRESS = {"chance", "decision", "reaction"}
    for start in seen:
        # find cycles reachable from `start` using iterative DFS coloring
        color = {i: 0 for i in seen}
        def dfs(i, path):
            color[i] = 1
            path.append(i)
            for j in sorted(adj[i]):
                if j not in seen:
                    continue
                if color[j] == 1:
                    cyc = path[path.index(j):]
                    if not any(doc["phases"][k]["kind"] in KINDS_PROGRESS
                               for k in cyc):
                        errs.append(
                            "no-progress loop: "
                            + " -> ".join(ids[k] for k in cyc))
                        return True
                elif color[j] == 0:
                    if dfs(j, path):
                        return True
            path.pop()
            color[i] = 2
            return False
        import sys as _sys
        _sys.setrecursionlimit(max(1000, len(ids) * 4))
        if dfs(start, []):
            break

    # ---- impossible actors -------------------------------------------------
    for ph in doc.get("phases", []):
        dec = ph.get("decision", {})
        act = dec.get("actor")
        if isinstance(act, int) and not 0 <= act < int(n_players):
            errs.append(f"phase {ph['id']}: actor seat {act} out of range")

    # ---- action with no state transition -----------------------------------
    for i, ph in enumerate(doc.get("phases", [])):
        if ph.get("kind") != "decision":
            continue
        for a in ph["decision"].get("actions", []):
            if (not a.get("effects") and not a.get("goto")
                    and i + 1 < len(ids)
                    and ids[i + 1] == ph["id"]):
                errs.append(
                    f"phase {ph['id']}/{a['id']}: no state transition "
                    f"(falls through to itself)")

    if errs:
        raise IRValidationError("; ".join(errs))
    return []


def validate_ir(doc: dict) -> list[str]:
    """Bound untrusted documents before traversing their semantic graph."""
    try:
        if not isinstance(doc, dict):
            _err("spec must be an object")
        if len(json.dumps(doc, allow_nan=False)) > 128_000:
            _err("spec exceeds 128 KB")
        def check(value, depth=0):
            if depth > 24:
                _err("spec nesting exceeds 24")
            if isinstance(value, float) and not math.isfinite(value):
                _err("numbers must be finite")
            if isinstance(value, dict):
                for key, item in value.items():
                    if key in {"code", "python", "javascript", "eval"}:
                        _err("executable fields are unsupported")
                    check(item, depth + 1)
            elif isinstance(value, list):
                if len(value) > 512:
                    _err("collection exceeds 512 entries")
                for item in value:
                    check(item, depth + 1)
        check(doc)
        for field in ("zones", "vars", "phases"):
            if not isinstance(doc.get(field), list):
                _err(f"{field} must be an array")
        if not 1 <= len(doc["phases"]) <= 128:
            _err("phases must contain 1..128 entries")
        entities = doc["entities"]
        ranks = entities["cardRanks"]
        if not isinstance(ranks, list) or any(type(r) is not int or not 0 <= r <= 1000 for r in ranks):
            _err("card ranks must be integers in 0..1000")
        copies = entities.get("copiesPerRank", 1)
        if type(copies) is not int or not 1 <= copies <= 16 or len(ranks) * copies > 256:
            _err("invalid deck size")
        for field in ("zones", "vars", "phases"):
            ids = [x["id"] for x in doc[field]]
            if len(ids) != len(set(ids)) or any(not isinstance(x, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,63}", x) for x in ids):
                _err(f"invalid or duplicate {field} ids")
        public = {z["id"] for z in doc["zones"] if z["visibility"] == "public"}
        zone_visibility = {z["id"]: z["visibility"] for z in doc["zones"]}
        private_vars = {
            v["id"] for v in doc["vars"]
            if v.get("visibility", "public") != "public"
        }

        def private_reference(expr) -> bool:
            """Whether an expression reads state that is not public.

            A public variable or indexed public zone cannot be assigned from a
            private value: the next filtered view would otherwise reveal that
            value to every seat. Private expressions remain valid for the
            acting seat's own candidates and for terminal utility formulas.
            """
            if not isinstance(expr, dict):
                return False
            if "var" in expr:
                return expr["var"] in private_vars
            if "sumRank" in expr:
                return zone_visibility.get(str(expr["sumRank"]).split("@", 1)[0], "hidden") != "public"
            if "cell" in expr:
                cell = expr["cell"]
                return zone_visibility.get(str(cell.get("zone", "")).split("@", 1)[0], "hidden") != "public" or private_reference(cell.get("index"))
            return any(private_reference(item) for item in expr.values() for item in (item if isinstance(item, list) else [item]))

        for ph in doc["phases"]:
            actions = list(ph.get("decision", ph.get("reaction", {})).get("actions", []))
            if doc.get("schemaVersion") == 2 and ph.get("kind") == "chance":
                actions.extend(ph.get("chance", {}).get("outcomes", []))
            for action in actions:
                visible = set(public)
                for effect in action.get("effects", []):
                    if effect.get("op") == "reveal":
                        visible.add(effect["zone"].split("@")[0])
                    if effect.get("op") == "set" and isinstance(effect.get("value"), dict) and "sumRank" in effect["value"]:
                        ref = effect["value"].get("sumRank", "").split("@")[0]
                        if ref not in visible:
                            _err("public variable cannot expose a private zone; reveal it first")
                    if effect.get("op") == "move" and (type(effect.get("n", 1)) is not int or effect.get("n", 1) < 1):
                        _err("move.n must be positive")
                    if doc.get("schemaVersion") == 2 and effect.get("op") == "set":
                        target = next((v for v in doc["vars"] if v["id"] == effect.get("var")), None)
                        if target and target.get("visibility", "public") == "public" and private_reference(effect.get("value")):
                            _err("public variable cannot expose a private expression")
                    if doc.get("schemaVersion") == 2 and effect.get("op") == "setCell":
                        if zone_visibility.get(str(effect.get("zone", "")).split("@", 1)[0], "hidden") == "public" and (private_reference(effect.get("index")) or private_reference(effect.get("value"))):
                            _err("public indexed zone cannot expose a private expression")
                    if doc.get("schemaVersion") == 2 and effect.get("op") == "compareGoto" and (private_reference(effect.get("a")) or private_reference(effect.get("b"))):
                        _err("phase transitions cannot branch on a private expression")
        if doc.get("schemaVersion") == 2:
            from .strategy_validation import lower_for_validation
            return _validate_ir(lower_for_validation(doc))
        return _validate_ir(doc)
    except IRValidationError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError) as exc:
        raise IRValidationError(f"malformed GameSpec: {exc}") from exc


def canonical_ir(doc: dict) -> str:
    return json.dumps(doc, sort_keys=True, separators=(",", ":"))


def ir_hash(doc: dict) -> str:
    return hashlib.sha256(canonical_ir(doc).encode()).hexdigest()


def load_ir(doc: dict) -> dict:
    """Validate and return the spec unchanged (data, not objects)."""
    validate_ir(doc)
    return doc
