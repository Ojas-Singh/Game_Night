"""Rules source for built-in games (Phase 11).

Every evaluation prompt must contain explicit rules; model training-data
knowledge is NEVER the rules source. Each entry carries a version and a
stable hash recorded into trajectories. Eventually these texts are generated
from GameSpec automatically — the registry interface is designed for that.
"""

from __future__ import annotations

import hashlib

RULES: dict[str, dict] = {
    "kuhn_poker": {
        "version": "1",
        "text": (
            "Kuhn Poker (2 players). Deck: J, Q, K (one each). Each player antes 1 and "
            "receives ONE face-down card. Betting: each player may have to act twice per "
            "round. On the first action a player may CHECK (pass) or BET 1. If one player "
            "bets, the other may FOLD (lose the pot) or CALL (match 1). If both check, the "
            "higher card wins the pot. After a bet and call, the higher card wins. Ties "
            "(impossible with one of each rank) would split. Winner takes the pot."
        ),
    },
    "leduc_poker": {
        "version": "1",
        "text": (
            "Leduc Poker (2 players). Deck: 2 suits x {J, Q, K} (6 cards). Each player "
            "antes 1 and receives ONE private card; after a betting round one PUBLIC card "
            "is revealed. Pairs (private+public equal rank) beat high cards, which beat "
            "nothing. Two betting rounds, max 2 raises per round (raise sizes: 2 then 2 in "
            "round one; 4 then 4 in round two... simplified: fixed raise as implemented by "
            "the environment). Showdown after the second betting round; best hand wins the "
            "pot; identical hands split."
        ),
    },
    "goofspiel": {
        "version": "1",
        "text": (
            "Goofspiel (2 players). A prize deck of N point cards is turned up one at a "
            "time. Each player holds an identical bid deck (same ranks) and simultaneously "
            "plays one bid card for the current prize; the HIGHER bid wins that prize's "
            "points. Equal bids: prize carries over or splits per environment rules. When "
            "all prizes are contested, higher total score wins. Your bid cards are spent "
            "permanently — manage your strength across the whole game."
        ),
    },
    "liars_dice": {
        "version": "1",
        "text": (
            "Liar's Dice (2 players here). Each player rolls dice kept hidden from the "
            "opponent. Players alternate making claims about the TOTAL number of dice of a "
            "given face across BOTH hands (your dice + opponent's unseen dice). Each claim "
            "must be strictly higher than the last (more dice of a face, same count of a "
            "higher face, or more dice). On your turn you may instead CALL LIE: the prior "
            "claim is checked against all real dice. If the claim is exactly met or "
            "exceeded, the caller loses a die; otherwise the claimer loses a die. Lose all "
            "dice and you lose."
        ),
    },
}


def rules_text(game_id: str) -> str:
    entry = RULES.get(game_id)
    if entry is None:
        # Generic structural fallback: never silently rely on memorized rules.
        return f"No curated rules registered for '{game_id}'. Play from the observation and legal actions alone."
    return entry["text"]


def rules_version(game_id: str) -> str:
    return RULES.get(game_id, {}).get("version", "0")


def rules_hash(game_id: str) -> str:
    return hashlib.sha1(rules_text(game_id).encode()).hexdigest()
