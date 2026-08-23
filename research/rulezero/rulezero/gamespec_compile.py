"""GameSpec → OpenSpiel compiler (Phase 25 seed experiment).

Compiles a GameSpecV0 into a registered OpenSpiel game (python-subclassed
Game/State). The interpreter is deterministic given the spec + game seed:
chance deals come from random.Random(seed) — injectable for differential
testing later.

Seed game: two-player one-card bet ("specduel"). Exercises everything the
pipeline needs: explicit chance, imperfect information, sequential decisions,
folds, showdown, zero-sum returns.
"""

from __future__ import annotations

import random

import pyspiel

from .gamespec_schema import GameSpecV0, parse_spec

_PASS, _RAISE, _FOLD, _CALL = 0, 1, 2, 3


def compile_spec(spec: GameSpecV0) -> pyspiel.Game:
    if spec.players_min != 2 or spec.players_max != 2:
        raise ValueError("v0 compiler supports exactly 2 players")

    class SpecState(pyspiel.State):
        def __init__(self, game):
            super().__init__(game)
            self._game: SpecGame = game
            self.rng = random.Random(game.get_parameters().get("seed", 12345))
            self.hands: list[int | None] = [None, None]
            self.deck: list[int] = []
            self.stage = 0  # 0=deal p0,1=deal p1,2..=bet tree,3=showdown
            self.contrib = [game.spec.ante, game.spec.ante]
            self.folded: bool | None = None
            self.raises_seen = 0

        # --- chance -----------------------------------------------------
        def _deal(self):
            if not self.deck:
                self.deck = [
                    r for r in self._game.spec.deck.ranks
                    for _ in range(self._game.spec.deck.copies_per_rank)
                ]
                self.rng.shuffle(self.deck)
            card = self.deck.pop()
            self.hands[self.stage] = card
            self.stage += 1

        # --- OpenSpiel interface ----------------------------------------
        def current_player(self):
            if self.stage < 2:
                return pyspiel.PlayerId.CHANCE
            return (self.stage - 2) % 2

        def legal_actions(self, player):
            if self.stage < 2:
                return []  # chance handled via chance_outcomes
            nd = self._decision_node(self.stage - 2)
            if player != self.current_player():
                return []
            if self.folded is not None:
                return []
            acts = [_PASS]
            if nd and self.raises_seen == 0:
                acts.append(_RAISE if self.stage - 2 == 0 else _CALL)
            return acts

        def _decision_node(self, idx: int):
            g = self._game
            if idx == 0:
                return g.spec.first_decision
            if idx == 1 and g.spec.second_decision:
                return g.spec.second_decision
            return None

        def apply_action(self, action: int):
            if self.stage < 2:
                self._deal()
                return
            if self.stage >= 4 or self.folded is not None:
                raise ValueError("no actions at terminal")
            nd = self._decision_node(self.stage - 2)
            actor = self.current_player()
            if action == _PASS:
                pass
            elif action == _RAISE:
                self.contrib[actor] += nd.raise_amount
                self.raises_seen += 1
            elif action == _CALL:
                to_call = self.contrib[1 - actor] - self.contrib[actor]
                self.contrib[actor] += max(0.0, to_call)
                self.raises_seen += 1
            elif action == _FOLD:
                self.folded = actor
            else:
                raise ValueError(f"bad action {action}")
            self.stage += 1

        def chance_outcomes(self):
            ranks = sorted({
                *self._game.spec.deck.ranks,
            })
            # Deal uniformly over distinct rank cards (v0 abstraction).
            n = len(ranks)
            probs = 1.0 / n
            return [(i, probs) for i in range(n)]

        def returns(self):
            # Everyone loses what they put in unless they win the pot.
            pot = sum(self.contrib)
            out = [-c for c in self.contrib]
            if self.folded is not None:
                out[self.folded] = -self.contrib[self.folded]
                w = 1 - self.folded
                out[w] = pot - self.contrib[w]
                return out
            a, b = self.hands
            if a == b:  # unreachable with distinct ranks; kept for safety
                return [0.0, 0.0]
            w = 0 if a > b else 1
            out[w] = pot - self.contrib[w]
            return out

        def is_terminal(self):
            return self.folded is not None or self.stage >= 4

        def legal_actions_mask(self):  # convenience for tensors
            return []

        def __str__(self):
            return f"stage={self.stage} hands={self.hands} contrib={self.contrib} folded={self.folded}"

        def observation_string(self, player):
            own = self.hands[player]
            opp = "hidden" if not self.is_terminal() else str(self.hands[1 - player])
            return f"your_card={own} opponent_card={opp} pot={sum(self.contrib)} stage={self.stage}"

        def action_to_string(self, player, action):
            return {_PASS: "PASS", _RAISE: "RAISE", _FOLD: "FOLD", _CALL: "CALL"}[action]

        def clone(self):
            st = SpecState(self._game)
            st.rng = random.Random(self.rng.random())
            st.hands = list(self.hands)
            st.deck = list(self.deck)
            st.stage = self.stage
            st.contrib = list(self.contrib)
            st.folded = self.folded
            st.raises_seen = self.raises_seen
            return st

    class SpecGame(pyspiel.Game):
        def __init__(self, params: dict):
            game_type = pyspiel.GameType(
                short_name="spec_" + params["spec_name"],
                long_name=f"GameSpec v0: {params['spec_name']}",
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
            max_pot = spec.ante + spec.first_decision.raise_amount
            game_info = pyspiel.GameInfo(
                num_distinct_actions=4,
                max_chance_outcomes=len(spec.deck.ranks),
                num_players=2,
                min_utility=-max_pot,
                max_utility=max_pot,
                utility_sum=0.0,
                max_game_length=6,
            )
            super().__init__(game_type, game_info, params)
            self.spec = spec  # closure reference; params stay JSON-safe

        def num_players(self):
            return 2

        def max_game_length(self):
            return 6

        def new_initial_state(self, seed: int | None = None):
            st = SpecState(self)
            if seed is not None:
                st.rng = random.Random(seed)
            return st

        def min_utility(self):
            return -float(self.spec.ante + self.spec.first_decision.raise_amount)

        def max_utility(self):
            return float(self.spec.ante + self.spec.first_decision.raise_amount)

    game = SpecGame({
        "seed": int(spec.seed),
        "spec_name": str(spec.name),
    })
    return game




def register_gamespec(spec_doc: dict) -> pyspiel.Game:
    """Parse, validate, canonicalize (hash), and instantiate the compiled game."""
    spec = parse_spec(spec_doc)
    return compile_spec(spec), spec.spec_hash(), spec.rules_text()
