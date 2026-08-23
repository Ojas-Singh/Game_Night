"""Generic OpenSpiel observation serializer (Phase 10).

One structural renderer for ANY OpenSpiel game — no game-specific prompt
code. Long-term research question: can an agent operate from structure alone?
Game-enhanced serializers may be added later ONLY as a comparison arm.
"""

from __future__ import annotations

from typing import Any

from .rules_registry import rules_hash, rules_text, rules_version


def game_metadata(game) -> str:  # pyspiel.Game
    t = game.get_type()
    return (
        f"game={t.short_name} players={game.num_players()} "
        f"dynamics={t.dynamics.name} chance={t.chance_mode.name} "
        f"information={t.information.name} utility={t.utility.name}"
    )


def information_state(game, state, player: int) -> str:
    """Best available per-player view; falls back to public history."""
    try:
        s = state.observation_string(player)
        if s and s.strip():
            return s
    except Exception:
        pass
    try:
        return state.information_state_string(player)
    except Exception:
        return state.history_str() or "(no history yet)"


def render_observation(game, state, player: int) -> str:
    """Full prompt body: metadata + explicit rules + view + legal actions."""
    legal = state.legal_actions(player)
    lines = [
        "GAME METADATA:",
        f"  {game_metadata(game)}",
        "",
        "RULES:",
        rules_text(game.get_type().short_name),
        "",
        f"CURRENT SITUATION (you are player {player}):",
        information_state(game, state, player),
        "",
        "LEGAL ACTIONS (pick exactly one id):",
    ]
    for aid in legal:
        lines.append(f"A{aid}: {state.action_to_string(player, aid)}")
    return "\n".join(lines)


def candidate_map(legal_actions: list[int]) -> dict[str, int]:
    """A0..An ids map to real action ids (identity here; stable interface)."""
    return {f"A{aid}": aid for aid in legal_actions}


def describe_game(game) -> dict[str, Any]:
    t = game.get_type()
    gid = t.short_name  # OpenSpiel 2.x: short name lives on GameType
    return {
        "gameId": gid,
        "rulesVersion": rules_version(gid),
        "rulesHash": rules_hash(gid),
        "players": game.num_players(),
        "dynamics": t.dynamics.name,
        "chanceMode": t.chance_mode.name,
        "information": t.information.name,
        "utility": t.utility.name,
        "maxGameLength": game.max_game_length(),
    }
