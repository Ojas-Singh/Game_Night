# Rules → Play implementation

Baseline: 3d25072. Preserve native engines and the single GameSpec interpreter.

- [x] M0: authority, atomic transitions, privacy/recall, persistence, worker lifecycle
- [x] M1: model compiler, bounded validation/jobs, accepted definitions, direct launch/share
- [x] M2: discovery, shared table controls, spectators
- [x] M3: CPU trainable policy, self-play/PPO, evaluation and checkpoints
- [x] M4: versioned strategy mechanics and transfer fixtures

Release gates require executable tests. The model-backed compiler is wired behind
`RULEZERO_COMPILER_URL`, `RULEZERO_COMPILER_MODEL`, and the optional
`RULEZERO_COMPILER_API_KEY`; without those settings Game Lab reports an explicit
unavailable state. Live compiler fidelity still requires a configured endpoint;
no fixture or mocked response counts as a model quality result. Browser tests are
included, but require a host with Playwright's Chromium shared libraries.

OpenCode Go can be used without a provider SDK by setting `OPENCODE_API_KEY`.
The compiler defaults to `https://opencode.ai/zen/go/v1` and `mimo-v2.5`, sends
the required stable `x-opencode-session` header for each compile job, and accepts
the OpenAI-compatible `/chat/completions` response. Use a chat-compatible Go
model (for example `mimo-v2.5`, `kimi-k3`, or `glm-5.2`); the compiler's strict
JSON contract remains enforced by GameSpec validation.
