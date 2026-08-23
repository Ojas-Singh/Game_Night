"""GameSpec v0 — bounded declarative schema for tiny card games (Phase 23/24).

specVersion 1 semantics (see gamespec_compile): chance nodes expose card
identities and are consumed verbatim; states hold no RNG.

v0 deliberately supports ONLY mechanics needed for the seed experiment:
fixed-size deck of ranked cards, hidden one-card deal per player, an
alternating check/bet-fold showdown tree, lowest-to-highest player counts.
No arbitrary code. Every spec canonicalizes to stable JSON + SHA-256 so every
trajectory can cite the exact rule set it was generated under.

Compiler target is OpenSpiel (python-subclassed Game), NOT a homegrown engine.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field


@dataclass(frozen=True)
class DeckSpec:
    ranks: tuple[int, ...]
    copies_per_rank: int = 1

    def total(self) -> int:
        return len(self.ranks) * self.copies_per_rank


@dataclass(frozen=True)
class BetNode:
    """One sequential betting decision for `actor`: pass or raise."""

    actor: str  # 'first' | 'second'
    raise_amount: float


@dataclass(frozen=True)
class GameSpecV0:
    name: str
    players_min: int
    players_max: int
    ante: float
    deck: DeckSpec
    # Betting tree v0: at most two sequential decisions pre-showdown.
    first_decision: BetNode
    second_decision: BetNode | None
    seed: int = 0  # procedural generation family marker

    def canonical(self) -> dict:
        return {
            "specVersion": 0,
            "name": self.name,
            "players": {"min": self.players_min, "max": self.players_max},
            "ante": self.ante,
            "deck": {
                "ranks": list(self.deck.ranks),
                "copiesPerRank": self.deck.copies_per_rank,
            },
            "firstDecision": {
                "actor": self.first_decision.actor,
                "raiseAmount": self.first_decision.raise_amount,
            },
            "secondDecision": (
                {
                    "actor": self.second_decision.actor,
                    "raiseAmount": self.second_decision.raise_amount,
                }
                if self.second_decision
                else None
            ),
        }

    def spec_hash(self) -> str:
        """SHA-256 of the canonical JSON (Phase-2 §11: away from SHA-1)."""
        canon = json.dumps(self.canonical(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canon.encode()).hexdigest()

    def rules_text(self) -> str:
        d = self.canonical()
        lines = [
            f"{self.name} ({self.players_min}-{self.players_max} players).",
            f"Ante {self.ante} each. Deck: ranks {d['deck']['ranks']} "
            f"(x{self.deck.copies_per_rank}). Each player is dealt ONE hidden card.",
            f"Decision 1 ({self.first_decision.actor} player): PASS (check) or RAISE {self.first_decision.raise_amount}.",
        ]
        if self.second_decision:
            lines.append(
                f"If raised, decision 2 ({self.second_decision.actor} player): FOLD (forfeit pot) "
                f"or CALL {self.second_decision.raise_amount}."
            )
        lines.append("Showdown: higher card wins the pot; equal ranks split. Cards rank by number.")
        return "\n".join(lines)


def parse_spec(doc: dict) -> GameSpecV0:
    """Validate + parse a raw JSON dict; raises ValueError on anything v0 cannot express."""
    required = {"name", "ante", "deck", "firstDecision"}
    missing = required - set(doc)
    if missing:
        raise ValueError(f"missing fields: {sorted(missing)}")
    deck = doc["deck"]
    ranks = tuple(int(r) for r in deck.get("ranks", []))
    if len(set(ranks)) != len(ranks) or not ranks:
        raise ValueError("deck.ranks must be non-empty unique ints")
    copies = int(deck.get("copiesPerRank", 1))
    if copies < 1:
        raise ValueError("copiesPerRank >= 1")

    def node(d: dict | None) -> BetNode | None:
        if d is None:
            return None
        if set(d) - {"actor", "raiseAmount"}:
            raise ValueError(f"unknown keys in decision: {sorted(set(d) - {'actor', 'raiseAmount'})}")
        return BetNode(actor=d["actor"], raise_amount=float(d["raiseAmount"]))

    players = doc.get("players", {"min": 2, "max": 2})
    return GameSpecV0(
        name=str(doc["name"]),
        players_min=int(players.get("min", 2)),
        players_max=int(players.get("max", 2)),
        ante=float(doc["ante"]),
        deck=DeckSpec(ranks=ranks, copies_per_rank=copies),
        first_decision=node(doc["firstDecision"]),
        second_decision=node(doc.get("secondDecision")),
        seed=int(doc.get("seed", 0)),
    )
