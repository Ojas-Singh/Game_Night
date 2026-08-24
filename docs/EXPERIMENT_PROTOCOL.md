# EXPERIMENT PROTOCOL (RuleZero)

How every RuleZero training experiment is specified, run, recorded, and
compared. Nothing in here is provider-specific; backends are interchangeable
(§21).

## 1. Roles

| Piece | Responsibility |
|---|---|
| `TrainingAlgorithm` | loop/schedule over a dataset (`rulezero.backends.SFT`, later: distillation, RL, active learning) |
| `ModelBackend` | rendering, sampling, training primitive, checkpoints, metadata (`LocalBackend`, `TinkerBackend`) |
| Teacher | an OpenSpiel solver policy (e.g. `CFRSolver.average_policy`). **Never reimplemented** (§33) |
| Student | any `ModelBackend` |
| Environment | OpenSpiel game / GameSpec runtime — never imports a model provider |

## 2. Data contract

Supervision examples are `RenderedExample` objects — plain data, identical
for local or Tinker targets (§32 gate):

```
info_state_key          canonical information-state identity
prompt                  fully rendered input text
candidates              dense candidate ids A0..An      (§8)
target                  gold candidateId
environment_action_ids  candidateId -> env action int
teacher_probs           optional teacher distribution    (distillation/§29)
weight                  per-example importance           (active learning, §25)
```

Renderer in force: `rulezero-action-only-v1`:

```
RULES <rules text>
STATE <information_state_string(player)>     # perfect-recall preferred (§7)
ACTIONS A0=<label> | A1=<label> ...
ANSWER:
```

Models emit a candidateId; mapping back to environment actions is recorded,
never learned.

## 3. First experiment (§23)

Kuhn Poker only — a solved game where correctness is known.

1. Teacher: `train_cfr_teacher(n)` → OpenSpiel CFRSolver average policy;
   record `exploitability` (nash_conv).
2. Dataset: `build_teacher_dataset` walks all reachable decision nodes; one
   example per unique information state; targets sampled from the teacher
   distribution.
3. Training: `SFT().run(backend, dataset, epochs)`.
4. Evaluation (all reported):
   - teacher imitation accuracy on the dataset;
   - average return over full games vs random opponent (backend acts through
     its public prompt/sample interface — no privileged state access);
   - legality violations forced during play (must be 0);
   - parse rate (1.0 for LocalBackend by construction);
   - wall time.
5. Manifest: `reports/experiments/<id>/manifest.json` records backend kind +
   model id + renderer + seed (+ LoRA rank / SDK version for Tinker),
   training-algorithm summary, checkpoint SHA-256, OpenSpiel version, and all
   metrics above. Dataset JSON is stored beside it (12 examples for Kuhn —
   small enough for Git under §19).

Ladder after Kuhn: Leduc → Goofspiel variant → Cabo (only once the training
path is proven).

## 4. Determinism

Same seed + same iteration counts ⇒ byte-identical manifest metrics and
checkpoint hash (tested). Any nondeterminism is a bug, not a nuisance.

## 5. Backend parity gate

Before any experiment claims a backend result, the identical dataset object
must be accepted by the target backend's interface, and switching backend
kind must require zero dataset changes. Provider imports stay inside backend
methods and behind `RULEZERO_ENABLE_TINKER` (tested at module level).

## 6. Artifact policy (§19)

Committed: manifests, tiny golden datasets, benchmark summaries, reports.
Not committed: large trajectories, checkpoints of real models, evaluation
dumps. Every manifest carries SHA-256 of its own checkpoint artifact.
