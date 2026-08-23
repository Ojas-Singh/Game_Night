"""GameSpec → OpenSpiel interpreter (Phase-2 Milestone 3, §9).

ONE generic data-driven runtime. The spec is DATA; this module interprets it.
No generated Python source per game, no embedded code execution.

§9 compliance fixes over v0:
- chance_outcomes() returns the remaining CARD IDENTITIES uniformly and
  apply_action(card) consumes exactly that action — no hidden internal draw;
- clone() is an exact deep copy (the state holds no RNG at all);
- every advertised legal action is genuinely applicable;
- static validation runs before instantiation (§11 subset).

v1 semantics (specVersion 1): deal stage exposes one chance node per player,
each uniform over the not-yet-dealt cards of the deck.
"""

from __future__ import annotations

import hashlib
import json

import pyspiel

from .gamespec_schema import GameSpecV0, parse_spec

_PASS, _RAISE, _FOLD, _CALL = 0, 1, 2, 3
_ACTION_NAMES = {_PASS: "PASS", _RAISE: "RAISE", _FOLD: "FOLD", _CALL: "CALL"}


# --------------------------------------------------------------------------
# §11 static validation (subset that applies to this spec family)
# --------------------------------------------------------------------------

def validate_spec_doc(doc: dict) -> list[str]:
    """Return a list of human-readable problems; empty == valid."""
    errs: list[str] = []
    try:
        spec = parse_spec(doc)
    except ValueError as e:
        return [f"parse: {e}"]

    if spec.players_min < 2 or spec.players_max > 6:
        errs.append("players must be within [2, 6]")
    if spec.players_min > spec.players_max:
        errs.append("players.min exceeds players.max")
    if spec.ante <= 0:
        errs.append("ante must be > 0")
    if spec.first_decision.raise_amount <= 0:
        errs.append("firstDecision.raiseAmount must be > 0")
    if spec.second_decision is not None and spec.second_decision.raise_amount <= 0:
        errs.append("secondDecision.raiseAmount must be > 0")
    if spec.deck.total() < 2 * spec.players_min:
        errs.append("deck smaller than two cards per minimum player count")
    if len(spec.deck.ranks) > 13:
        errs.append("more than 13 ranks unsupported (card identity space)")
    # Terminal rule is structural in this family (showdown/fold always ends),
    # so nothing further to check here; kept explicit for future families.
    return errs


# --------------------------------------------------------------------------
# Generic interpreter
# --------------------------------------------------------------------------

def compile_spec(spec: GameSpecV0) -> pyspiel.Game:
    if spec.players_min != 2 or spec.players_max != 2:
        raise ValueError("this interpreter currently supports exactly 2 players")

    class SpecState(pyspiel.State):
        """Interpreted state. Holds NO RNG: all randomness is chance nodes."""

        def __init__(self, game):
            super().__init__(game)
            self._game: SpecGame = game
            g = game.spec
            self.pool: list[int] = sorted(
                r for r in g.deck.ranks for _ in range(g.deck.copies_per_rank))
            self.hands: list[int | None] = [None, None]
            self.stage = 0          # 0..1 = deals, 2..3 = bet tree, >=4 showdown
            self.contrib = [float(g.ante), float(g.ante)]
            self.folded: int | None = None
            self.raises_seen = 0

        # --- §9 chance: identities, uniform, consumed verbatim -------------
        def is_chance_node(self):
            return self.stage < 2 and self.folded is None

        def chance_outcomes(self):
            n = len(self.pool)
            p = 1.0 / n
            return [(c, p) for c in self.pool]

        def current_player(self):
            if self.is_terminal():
                return pyspiel.PlayerId.TERMINAL
            if self.is_chance_node():
                return pyspiel.PlayerId.CHANCE
            return (self.stage - 2) % 2

        def legal_actions(self, player):
            if self.is_terminal() or self.is_chance_node():
                return []
            if player != self.current_player() or self.folded is not None:
                return []
            acts = [_PASS]
            nd = self._decision_node(self.stage - 2)
            if self.stage - 2 == 0 and self.raises_seen == 0:
                acts.append(_RAISE)
            elif (self.stage - 2 == 1 and self.raises_seen == 0
                  and nd is not None):
                acts.append(_CALL)
            return acts

        def _decision_node(self, idx: int):
            g = self._game
            if idx == 0:
                return g.spec.first_decision
            if idx == 1 and g.spec.second_decision:
                return g.spec.second_decision
            return None

        def apply_action(self, action: int):
            if self.is_chance_node():
                card = int(action)
                if card not in self.pool:
                    raise ValueError(f"chance action {card} not in pool")
                self.pool.remove(card)
                self.hands[self.stage] = card
                self.stage += 1
                return
            if self.folded is not None or self.stage >= 4:
                raise ValueError("no actions at terminal")
            if action not in self.legal_actions(self.current_player()):
                raise ValueError(f"illegal action {action}")
            nd = self._decision_node(self.stage - 2)
            actor = self.current_player()
            if action == _PASS:
                pass
            elif action == _RAISE:
                self.contrib[actor] += float(nd.raise_amount)
                self.raises_seen += 1
            elif action == _CALL:
                to_call = self.contrib[1 - actor] - self.contrib[actor]
                self.contrib[actor] += max(0.0, to_call)
                self.raises_seen += 1
            else:  # _FOLD
                self.folded = actor
            self.stage += 1

        def returns(self):
            pot = sum(self.contrib)
            out = [-c for c in self.contrib]
            if self.folded is not None:
                w = 1 - self.folded
                out[w] = pot - self.contrib[w]
                return out
            a, b = self.hands
            if a == b:
                return [0.0, 0.0]
            w = 0 if a > b else 1
            out[w] = pot - self.contrib[w]
            return out

        def is_terminal(self):
            return self.folded is not None or self.stage >= 4

        def __str__(self):
            return (f"stage={self.stage} hands={self.hands} "
                    f"contrib={self.contrib} folded={self.folded}")

        def observation_string(self, player):
            own = self.hands[player]
            opp = ("hidden" if not self.is_terminal()
                   else str(self.hands[1 - player]))
            return f"your_card={own} opponent_card={opp} pot={sum(self.contrib)}"

        def information_state_string(self, player):
            base = self.observation_string(player)
            hist = "".join(
                _ACTION_NAMES.get(a, str(a)) for _p, a in self.history()
                if isinstance(_p, int))
            return f"{base} history={hist}"

        def action_to_string(self, player, action):
            return _ACTION_NAMES[action]

        def clone(self):
            st = SpecState(self._game)
            st.pool = list(self.pool)
            st.hands = list(self.hands)
            st.stage = self.stage
            st.contrib = list(self.contrib)
            st.folded = self.folded
            st.raises_seen = self.raises_seen
            return st

    class SpecGame(pyspiel.Game):
        def __init__(self, params: dict):
            game_type = pyspiel.GameType(
                short_name="spec_" + params["spec_name"],
                long_name=f"GameSpec v1: {params['spec_name']}",
                dynamics=pyspiel.GameType.Dynamics.SEQUENTIAL,
                chance_mode=pyspiel.GameType.ChanceMode.EXPLICIT_STOCHASTIC,
                information=pyspiel.GameType.Information.IMPERFECT_INFORMATION,
                utility=pyspiel.GameType.Utility.ZERO_SUM,
                reward_model=pyspiel.GameType.RewardModel.TERMINAL,
                max_num_players=2,
                min_num_players=2,
                provides_information_state_string=True,
                provides_information_state_tensor=False,
                provides_observation_string=True,
                provides_observation_tensor=False,
                parameter_specification={"seed": -1, "spec_name": ""},
            )
            max_pot = 2.0 * spec.ante + spec.first_decision.raise_amount
            game_info = pyspiel.GameInfo(
                num_distinct_actions=4,
                max_chance_outcomes=max(2, spec.deck.total()),
                num_players=2,
                min_utility=-max_pot,
                max_utility=max_pot,
                utility_sum=0.0,
                max_game_length=8,
            )
            super().__init__(game_type, game_info, params)
            self.spec = spec

        def num_players(self):
            return 2

        def max_game_length(self):
            return 8

        def new_initial_state(self, seed: int | None = None):
            # seed retained for API compatibility; randomness lives ONLY in
            # chance nodes now, so the initial state is always identical.
            return SpecState(self)

        def min_utility(self):
            return -float(2 * self.spec.ante
                          + self.spec.first_decision.raise_amount)

        def max_utility(self):
            return float(2 * self.spec.ante
                         + self.spec.first_decision.raise_amount)

    return SpecGame({
        "seed": int(spec.seed),
        "spec_name": str(spec.name),
    })


def register_gamespec(spec_doc: dict):
    """Validate → parse → instantiate. Returns (game, sha256, rules_text).

    Raises ValueError listing every validation problem before compiling.
    """
    errs = validate_spec_doc(spec_doc)
    if errs:
        raise ValueError("invalid GameSpec: " + "; ".join(errs))
    spec = parse_spec(spec_doc)
    canon = json.dumps(spec.canonical(), sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(canon.encode()).hexdigest()
    return compile_spec(spec), digest, spec.rules_text()
