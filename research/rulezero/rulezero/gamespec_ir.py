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
  {"op":"compareGoto","a":A,"b":B,
   "gt":P,"lt":P,"eq":P}                  compare rank sums, jump phases
Zone expressions: "deck", "prizes", "hand@p", "won@i", "@actor", "@other",
"pot" (var). "@p"/"@i" bind to the acting player index at execution time.
"""

from __future__ import annotations

import hashlib
import json

_PHASE_KINDS = {"chance", "decision", "reaction", "award", "terminal"}
_VIS = {"hidden", "owner", "public"}
_OPS = {"incr", "dec", "set", "move", "reveal", "clear",
        "compareGoto"}
_ACTOR_SPECS = {"allOthersAfterLastActor", "rotate"}


class IRValidationError(ValueError):
    pass


def _err(msg):  # raise helper keeping validate() readable
    raise IRValidationError(msg)


def validate_ir(doc: dict) -> list[str]:
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

    if errs:
        raise IRValidationError("; ".join(errs))
    return []


def canonical_ir(doc: dict) -> str:
    return json.dumps(doc, sort_keys=True, separators=(",", ":"))


def ir_hash(doc: dict) -> str:
    return hashlib.sha256(canonical_ir(doc).encode()).hexdigest()


def load_ir(doc: dict) -> dict:
    """Validate and return the spec unchanged (data, not objects)."""
    validate_ir(doc)
    return doc
