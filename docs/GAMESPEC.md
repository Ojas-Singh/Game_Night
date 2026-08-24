# GameSpec — the formal game language

GameSpec is the semantic source for every generated game. It is DATA. The
generic interpreter in `research/rulezero/rulezero/gamespec_runtime.py`
executes it; nothing is code-generated and no embedded Python/JS is executed.

## Versions

- **v0** (`gamespec_schema.py`): historical seed experiment (one-card bet
  duel). Kept as regression fixture.
- **v1** (`gamespec_ir.py`, `schemaVersion: 1`): the real IR subset.

## v1 IR surface

```jsonc
{
  "schemaVersion": 1,
  "name": "...",
  "players": {"count": 2},
  "entities": {"cardRanks": [..], "copiesPerRank": n},
  "zones": [{"id", "perPlayer": bool, "visibility": "hidden|owner|public"}],
  "vars":   [{"id", "init"}],
  "phases": [
    {"id", "kind": "chance",
     "chance": {"from", "to", "count", "roundRobin": bool}},
    {"id", "kind": "decision",
     "decision": {"actor": <seat>|'rotate',
                  "actions": [{"id", "requires"?, "effects"?, "goto"?}]}},
    {"id", "kind": "reaction",          // generic reaction window (§5)
     "reaction": {"actors": "allOthersAfterLastActor",
                  "priority": "seatOrder",
                  "actions": [{"id", "endsWindow"?, "effects"?, "goto"?}]}},
    {"id", "kind": "award",
     "award": {"to": "compareZones|lastActor|otherOfLast|splitAll",
               "a"?, "b"?, "amountVar"?|"amount"?, "tieSplit"?, "goto"?}},
    {"id", "kind": "terminal"}
  ]
}
```

Effects: `incr`, `dec`, `set`, `move` (+`rank`, +`n`), `reveal`, `clear`,
`compareGoto` (`gt/lt/eq` phase jumps). Zone refs bind `@p/@actor/@i`
(acting player), `@other`, or fixed seat suffix (`hand0`).

Preconditions: `{"var": V, "eq": X}` or `{"cardInHand": {"zone", "rank"}}`.

## Guarantees

- Chance phases are sequences of uniform draw-without-replacement nodes;
  `chance_outcomes()` returns card identities and `apply_action` consumes
  exactly that card. States hold NO RNG.
- `clone()` is exact and mutation-isolated.
- Zone visibility drives observations; leak-checked per zone segment.
- Every spec gets schemaVersion + canonical JSON + SHA-256 (`ir_hash`).
- Acceptance = passing `rulezero/compliance.py` (§12), not merely parsing.

## Worked examples

See `rulezero/test_ir_games.py`: `kuhnish` (hidden-card betting),
`goofseq` (public prizes, private resource bidding), `claim` (bluffing
through a generic reaction window).

## Deliberate v1 limitations (expansion queue)

Simultaneous moves, dice/random-choice entities beyond cards, grids,
selected-player visibility, emit/log events, structured scoring expressions.
The vocabulary mirrors master-plan §10 so these are additive.
