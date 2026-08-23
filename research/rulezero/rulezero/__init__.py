"""RuleZero — OpenSpiel-first research stack for general strategic intelligence.

Principles (see docs/RULEZERO_ARCHITECTURE.md):
  - OpenSpiel owns algorithms; we write thin wrappers, never reimplementations.
  - Simulators are authoritative: agents choose among legal actions only.
  - Rules are explicit in every prompt; models never rely on memorized games.
  - Research inference is strict: model failures are recorded, not rescued.
"""

__version__ = "0.1.0"
