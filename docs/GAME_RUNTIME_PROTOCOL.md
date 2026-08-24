# Game Runtime Protocol — `game-service/v1`

Internal protocol between the Game Night TypeScript server and the RuleZero
Python game service (`research/rulezero/rulezero/service.py`). The service
is NEVER exposed to browsers; the TS server spawns it as a subprocess
(same line-JSON stdio pattern as the cabo differential bridge).

## Layering

```
browser ──(game-night sockets)──> TS server ──(game-service/v1, stdio)──> rulezero service ──> OpenSpiel/GameSpec
```

TS learns nothing about generated game rules. It forwards opaque spec JSON
at creation and renders whatever views the service emits.

## Requests / responses

One JSON object per line. Responses are `{"ok":true,...}` or
`{"ok":false,"error":"..."}`.

| op | payload | effect |
|---|---|---|
| `create` | `{"spec": <GameSpec IR>, "seed"?: int}` | new session; chance resolved server-side |
| `view` | `{"player": p}` | structured per-player view (below) |
| `legalActions` | `{"player": p}` | environment action ints for the current actor |
| `apply` | `{"action": int}` | apply for current actor; chance re-resolved after |
| `snapshot` | — | full state dict incl. history + window (for reconnect) |
| `restore` | `{"state": snap}` | resume from snapshot; refuses foreign `specHash` |
| `isTerminal` | — | boolean |
| `returns` | — | terminal utilities (null before end) |

## View payload

```jsonc
{
  "protocol": "game-service/v1",
  "specHash": "sha256…",
  "player": 0,
  "phase": "act1",
  "observation": "...",          // string form
  "informationState": "[p0] … hist=…",  // perfect-recall form
  "isTerminal": false,
  "currentActor": 0,
  "candidates": [                 // dense ids only (§8)
    {"candidateId": "A0", "environmentActionId": 0, "label": "A0:fold"}
  ],
  "zones": [                      // visibility filtered AT THE SOURCE
    {"id": "hand0", "visibility": "owner", "owner": 0, "cards": [10]},
    {"id": "hand1", "visibility": "owner", "owner": 1, "count": 1},
    {"id": "prize", "visibility": "public", "owner": null, "cards": [3]},
    {"id": "deck",  "visibility": "hidden", "owner": null, "count": 2}
  ],
  "scores": {"0": -1, "1": -1}
}
```

Privacy guarantee: hidden zones arrive as counts only and owner zones carry
card contents **only in that owner's own view** (and everything once
terminal). The browser cannot leak what it never received.

Chance semantics: the canonical env keeps explicit §6 chance nodes; the
SERVICE samples them internally so clients never drive randomness.

Generic renderer: `apps/web/src/rulezero/RuleZeroTable.tsx` renders any view
payload without game-specific code (demo at `/rulezero-demo`).
