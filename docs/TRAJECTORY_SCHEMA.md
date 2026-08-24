# TRAJECTORY SCHEMA (RuleZero v1)

Canonical record of one episode played through any RuleZero runtime
(OpenSpiel game or GameSpec interpreter). Trajectories are immutable
artifacts (§19): stored as JSONL, one episode per line, never edited.

```jsonc
{
  "schemaVersion": 1,
  "trajectoryId": "uuid",
  "game": {
    "id": "kuhn_poker | gamespec:<specHash>",
    "specHash": "sha256… (null for stock OpenSpiel games)",
    "numPlayers": 2,
    "parameters": { "players": 2 }
  },
  "provenance": {
    "producingCommit": "git sha of the runner",
    "runner": "rulezero.selfplay@<version>",
    "createdAt": "ISO-8601"
  },
  "seedSchedule": [12345, 678],          // chance seeds, one per shuffle node
  "returns": [-1.0, 1.0],                // OpenSpiel utility per player
  "finalScores": {"0": 4, "1": 7},       // raw game points (Cabo hand totals etc.)
  "transitions": [
    {
      "t": 0,
      "player": -1,                      // -1 = chance
      "kind": "chance | decision | reaction",
      "infoState": "0pb",                // information_state_string(player)
      "observation": "<optional raw observation string>",
      "legalEnvironmentActions": [0, 1],
      "candidates": [
        { "candidateId": "A0", "environmentActionId": 0, "label": "check/fold" },
        { "candidateId": "A1", "environmentActionId": 1, "label": "bet/call" }
      ],
      "chosenCandidateId": "A1",
      "chosenEnvironmentActionId": 1,
      "policy": null,                    // optional: model distribution over candidates
      "teacherPolicy": [0.3, 0.7],       // optional: solver distribution over candidates
      "valueTarget": null,               // reserved (§29)
      "beliefTarget": null               // reserved (§29)
    }
  ]
}
```

## Invariants

- `candidates[i].environmentActionId` is always a legal action **at that
  state**; candidate ids are dense A0..An and re-derived per decision — they
  are positional, never semantic (§8).
- Chance transitions record the sampled outcome as their action; states hold
  no RNG, so replaying `seedSchedule` reproduces the episode exactly.
- `infoState` uses perfect-recall strings when available; observation and
  information state are recorded as distinct fields (§7).
- Hidden-information privacy: nothing in a transition may contain hidden card
  identities unless the acting player legitimately knew them at decision time
  or the state is terminal. Leak-checker tests enforce this for GameSpec
  views.
- `returns` is the bounded utility actually optimized (±1/0 for Cabo);
  `finalScores` keeps raw points as metadata only (§4).
- `policy` / `teacherPolicy` / `valueTarget` / `beliefTarget` are nullable so
  the same schema serves SFT today and policy/value/belief training later
  (§29) without a breaking change.

## Storage

- Small golden episodes: committed under `research/rulezero/fixtures/`.
- Bulk self-play data: artifact store (filesystem now, object storage later),
  referenced by `trajectoryId` + SHA-256 in manifests — never in Git (§19).
