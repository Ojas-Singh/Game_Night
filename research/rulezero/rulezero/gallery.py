"""Game Lab gallery (Phase 3A §15/§16): GameSpec-only example games.

Every entry is pure data — the ONE generic interpreter runs all of them.
No hand-coded runtimes anywhere (§15). Typed mutations produce real spec
variants that must re-pass validation (§16/§17), never source-text edits.
"""
from __future__ import annotations

import copy
from typing import Any

from .gamespec_ir import ir_hash, load_ir

# ---------------------------------------------------------------------------
# Specs
# ---------------------------------------------------------------------------

HIDDEN_DUEL = {
    "schemaVersion": 1,
    "name": "hidden_duel",
    "players": {"count": 2},
    "entities": {"cardRanks": [3, 4, 5], "copiesPerRank": 1},
    "zones": [
        {"id": "deck", "visibility": "hidden"},
        {"id": "hand", "perPlayer": True, "visibility": "owner"},
    ],
    "vars": [
        {"id": "pot", "init": 2},
        {"id": "score0", "init": -1},
        {"id": "score1", "init": -1},
    ],
    "phases": [
        {"id": "deal", "kind": "chance",
         "chance": {"from": "deck", "to": "hand@p", "count": 1}},
        {"id": "strike", "kind": "decision",
         "decision": {"actor": 0, "actions": [
             {"id": "pass", "goto": "showdown"},
             {"id": "double", "effects": [{"op": "incr", "var": "pot", "by": 2}],
              "goto": "showdown"}]}},
        {"id": "showdown", "kind": "decision",
         "decision": {"actor": 0, "actions": [
             {"id": "reveal", "effects": [
                 {"op": "reveal", "zone": "hand@p"},
                 {"op": "compareGoto",
                  "a": {"sumRank": "hand@p"}, "b": {"sumRank": "hand@other"},
                  "gt": "win_revealer", "lt": "win_other", "eq": "tie"}]}]}},
        {"id": "win_revealer", "kind": "award",
         "award": {"to": "lastActor", "amountVar": "pot", "goto": "end"}},
        {"id": "win_other", "kind": "award",
         "award": {"to": "otherOfLast", "amountVar": "pot", "goto": "end"}},
        {"id": "tie", "kind": "award",
         "award": {"to": "splitAll", "amountVar": "pot", "goto": "end"}},
        {"id": "end", "kind": "terminal"},
    ],
}


def _mini_bluff(ranks: list[int], bet_size: int) -> dict[str, Any]:
    """Family generator (§16): kuhn-shaped poker with typed knobs."""
    return {
        "schemaVersion": 1,
        "name": "mini_bluff",
        "players": {"count": 2},
        "entities": {"cardRanks": ranks, "copiesPerRank": 1},
        "zones": [
            {"id": "deck", "visibility": "hidden"},
            {"id": "hand", "perPlayer": True, "visibility": "owner"},
        ],
        "vars": [
            {"id": "pot", "init": 2},
            {"id": "raised", "init": 0},
            {"id": "score0", "init": -bet_size},
            {"id": "score1", "init": -bet_size},
        ],
        "phases": [
            {"id": "deal", "kind": "chance",
             "chance": {"from": "deck", "to": "hand@p", "count": 1}},
            {"id": "act0", "kind": "decision",
             "decision": {"actor": 0, "actions": [
                 {"id": "check", "goto": "act1"},
                 {"id": "bet", "effects": [
                     {"op": "incr", "var": "pot", "by": bet_size},
                     {"op": "set", "var": "raised", "value": 1}],
                  "goto": "act1"}]}},
            {"id": "act1", "kind": "decision",
             "decision": {"actor": 1, "actions": [
                 {"id": "fold", "goto": "fold_award"},
                 {"id": "call", "requires": {"var": "raised", "eq": 1},
                  "effects": [{"op": "incr", "var": "pot", "by": bet_size}],
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
             "award": {"to": "otherOfLast", "amountVar": "pot", "goto": "end"}},
            {"id": "win_revealer", "kind": "award",
             "award": {"to": "lastActor", "amountVar": "pot", "goto": "end"}},
            {"id": "win_other", "kind": "award",
             "award": {"to": "otherOfLast", "amountVar": "pot", "goto": "end"}},
            {"id": "tie", "kind": "award",
             "award": {"to": "splitAll", "amountVar": "pot", "goto": "end"}},
            {"id": "end", "kind": "terminal"},
        ],
    }


SECRET_BID = {
    "schemaVersion": 1,
    "name": "secret_bid",
    "players": {"count": 2},
    # 9 cards: 6 dealt as hands (bidding currency), 3 remain as the
    # face-up prize stack.
    "entities": {"cardRanks": [2, 4, 6], "copiesPerRank": 3},
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
        {"id": "deal", "kind": "chance",
         "chance": {"from": "deck", "to": "hand@p", "count": 3}},
        {"id": "flip", "kind": "chance",
         "chance": {"from": "deck", "to": "prize", "count": 1,
                    "roundRobin": False}},
        {"id": "price", "kind": "decision",
         "decision": {"actor": 0, "actions": [{
             "id": "value",
             "effects": [{"op": "set", "var": "prizeval",
                          "value": {"sumRank": "prize"}}]}]}},
        {"id": "bidA", "kind": "decision",
         "decision": {"actor": 0, "actions": [
             {"id": f"play{r}",
              "requires": {"cardInHand": {"zone": "hand@p", "rank": r}},
              "effects": [{"op": "move", "from": "hand@p", "to": "bidA",
                           "rank": r}]}
             for r in (2, 4, 6)]}},
        {"id": "bidB", "kind": "decision",
         "decision": {"actor": 1, "actions": [
             {"id": f"play{r}",
              "requires": {"cardInHand": {"zone": "hand@p", "rank": r}},
              "effects": [{"op": "move", "from": "hand@p", "to": "bidB",
                           "rank": r}]}
             for r in (2, 4, 6)]}},
        {"id": "take", "kind": "award",
         "award": {"to": "compareZones",
                   "a": {"sumRank": "bidA"}, "b": {"sumRank": "bidB"},
                   "amountVar": "prizeval", "tieSplit": True, "goto": "end"}},
        {"id": "end", "kind": "terminal"},
    ],
}

REVEAL_HOLD = {
    "schemaVersion": 1,
    "name": "reveal_hold",
    "players": {"count": 2},
    # Reveal commits your true strength to a public pile; holding scores
    # nothing. Both hold -> split; one reveals -> revealer beats zero;
    # both reveal -> higher card wins.
    "entities": {"cardRanks": [1, 3, 5], "copiesPerRank": 1},
    "zones": [
        {"id": "deck", "visibility": "hidden"},
        {"id": "hand", "perPlayer": True, "visibility": "owner"},
        {"id": "showA", "visibility": "public"},
        {"id": "showB", "visibility": "public"},
    ],
    "vars": [
        {"id": "ante", "init": 2},
        {"id": "score0", "init": 0},
        {"id": "score1", "init": 0},
    ],
    "phases": [
        {"id": "deal", "kind": "chance",
         "chance": {"from": "deck", "to": "hand@p", "count": 1}},
        {"id": "choiceA", "kind": "decision",
         "decision": {"actor": 0, "actions": [
             {"id": "reveal",
              "effects": [{"op": "move", "from": "hand@p", "to": "showA"}]},
             {"id": "hold"}]}},
        {"id": "choiceB", "kind": "decision",
         "decision": {"actor": 1, "actions": [
             {"id": "reveal",
              "effects": [{"op": "move", "from": "hand@p", "to": "showB"}]},
             {"id": "hold"}]}},
        {"id": "award", "kind": "award",
         "award": {"to": "compareZones",
                   "a": {"sumRank": "showA"}, "b": {"sumRank": "showB"},
                   "amountVar": "ante", "tieSplit": True, "goto": "end"}},
        {"id": "end", "kind": "terminal"},
    ],
}

DOUBLE_OR_NOTHING = {
    "schemaVersion": 1,
    "name": "double_or_nothing",
    "players": {"count": 2},
    "entities": {"cardRanks": [2, 3, 4], "copiesPerRank": 1},
    "zones": [
        {"id": "deck", "visibility": "hidden"},
        {"id": "hand", "perPlayer": True, "visibility": "owner"},
        {"id": "spent", "visibility": "public"},
    ],
    "vars": [
        {"id": "pot", "init": 2},
        {"id": "score0", "init": -1},
        {"id": "score1", "init": -1},
    ],
    "phases": [
        # ---- duel 1 ----
        {"id": "deal1", "kind": "chance",
         "chance": {"from": "deck", "to": "hand@p", "count": 1}},
        {"id": "duel1", "kind": "decision",
         "decision": {"actor": 0, "actions": [
             {"id": "reveal", "effects": [
                 {"op": "reveal", "zone": "hand@p"},
                 {"op": "compareGoto",
                  "a": {"sumRank": "hand@p"}, "b": {"sumRank": "hand@other"},
                  "gt": "leader_stakes", "lt": "other_wins1", "eq": "tie1"}]}]}},
        {"id": "other_wins1", "kind": "award",
         "award": {"to": "otherOfLast", "amountVar": "pot", "goto": "end"}},
        {"id": "tie1", "kind": "award",
         "award": {"to": "splitAll", "amountVar": "pot", "goto": "end"}},
        # Winner (lastActor) may press the whole pot into one more duel.
        {"id": "leader_stakes", "kind": "decision",
         "decision": {"actor": 0, "actions": [
             {"id": "bank", "goto": "bank_win"},
             {"id": "press", "effects": [
                 {"op": "incr", "var": "pot", "by": 2},
                 {"op": "move", "from": "hand@p", "to": "spent"},
                 ], "goto": "deal2"}]}},
        # ---- duel 2 (fresh card for the pressed leader) ----
        {"id": "deal2", "kind": "chance",
         "chance": {"from": "deck", "to": "hand@p", "count": 1,
                    "roundRobin": False}},
        {"id": "duel2", "kind": "decision",
         "decision": {"actor": 0, "actions": [
             {"id": "reveal", "effects": [
                 {"op": "reveal", "zone": "hand@p"},
                 {"op": "compareGoto",
                  "a": {"sumRank": "hand@p"}, "b": {"sumRank": "hand@other"},
                  "gt": "bank_win", "lt": "other_wins2", "eq": "bank_win"}]}]}},
        {"id": "other_wins2", "kind": "award",
         "award": {"to": "otherOfLast", "amountVar": "pot", "goto": "end"}},
        {"id": "bank_win", "kind": "award",
         "award": {"to": "lastActor", "amountVar": "pot", "goto": "end"}},
        {"id": "end", "kind": "terminal"},
    ],
}

# Existing validated specs join the gallery unchanged.
from .test_ir_games import CLAIM, GOOFSEQ, KUHNISH  # noqa: E402


def _kuhnish_funded() -> dict[str, Any]:
    """Gallery version: the shared test fixture but with a real ante in the
    pot so fold/showdown payouts are non-degenerate."""
    doc = copy.deepcopy(KUHNISH)
    for v in doc["vars"]:
        if v["id"] == "pot":
            v["init"] = 2
    return doc

# ---------------------------------------------------------------------------
# Gallery registry (§15) — capability tags feed the UI cards + AI selector
# ---------------------------------------------------------------------------


class GalleryEntry:
    def __init__(
        self,
        gid: str,
        title: str,
        blurb: str,
        tags: list[str],
        spec_fn,
        mutations: dict[str, list[Any]] | None = None,
    ) -> None:
        self.id = gid
        self.title = title
        self.blurb = blurb
        self.tags = tags
        self._spec_fn = spec_fn
        self.mutations = mutations or {}

    def spec(self) -> dict[str, Any]:
        return copy.deepcopy(self._spec_fn())

    def variant(self, **params: Any) -> dict[str, Any]:
        """Typed mutation (§16/§17): returns a NEW spec; never edits source."""
        return copy.deepcopy(self._spec_fn(**params))


def _const(spec):
    return lambda **_: copy.deepcopy(spec)


def _mini_bluff_fn(ranks=None, bet_size=1, **_):
    return _mini_bluff(ranks or [9, 10, 11], bet_size)


GALLERY: dict[str, GalleryEntry] = {
    e.id: e
    for e in [
        GalleryEntry(
            "kuhnish", "Kuhnish Duel", "Tiny poker: one hidden card, one bet.",
            ["2 Players", "Hidden Information", "Bluffing"],
             _kuhnish_funded),
        GalleryEntry(
            "mini-bluff", "Mini Bluff",
            "Bluffing duel with adjustable deck and bet size.",
            ["2 Players", "Hidden Information", "Bluffing", "Chance"],
            _mini_bluff_fn,
            mutations={
                "ranks": [[9, 10, 11], [2, 3, 4, 5], [1, 2, 3, 4, 5]],
                "bet_size": [1, 2, 3],
            }),
        GalleryEntry(
            "hidden-duel", "Hidden Duel",
            "One hidden card each; before the reveal you may double the pot.",
            ["2 Players", "Hidden Information", "Chance"],
            _const(HIDDEN_DUEL)),
        GalleryEntry(
            "goofseq", "Prize Bidding",
            "Three public prizes; commit cards secretly to win each.",
            ["2 Players", "Hidden Information", "Resource Bidding", "Chance"],
            _const(GOOFSEQ)),
        GalleryEntry(
            "secret-bid", "Secret Bid",
            "One sealed-bid prize: spend your best card or save it.",
            ["2 Players", "Hidden Information", "Resource Bidding"],
            _const(SECRET_BID)),
        GalleryEntry(
            "claim", "Counter Claim",
            "Claim high or low; the opponent may challenge and punish lies.",
            ["2 Players", "Hidden Information", "Bluffing", "Reaction"],
            _const(CLAIM)),
        GalleryEntry(
            "reveal-hold", "Reveal or Hold",
            "Show your true card or conceal it and hope.",
            ["2 Players", "Hidden Information", "Bluffing"],
            _const(REVEAL_HOLD)),
        GalleryEntry(
            "double-or-nothing", "Double or Nothing",
            "Win the duel — then press the whole pot on one more card?",
            ["2 Players", "Hidden Information", "Chance", "Push-Your-Luck"],
            _const(DOUBLE_OR_NOTHING)),
    ]
}


def catalog() -> list[dict[str, Any]]:
    """UI-facing catalog: tags + hashes, no giant JSON."""
    out = []
    for e in GALLERY.values():
        doc = load_ir(e.spec())
        out.append({
            "id": e.id,
            "title": e.title,
            "blurb": e.blurb,
            "tags": e.tags,
            "specHash": ir_hash(doc),
            "mutations": sorted(e.mutations.keys()),
        })
    return out


def get_spec(gallery_id: str) -> dict[str, Any]:
    if gallery_id not in GALLERY:
        raise KeyError(f"unknown gallery game: {gallery_id}")
    return load_ir(GALLERY[gallery_id].spec())
