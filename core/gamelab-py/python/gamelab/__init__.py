"""Game Night rules core for Python.

`Tables` plays many rounds at once and hands out NumPy arrays; `Round` is one
round of one game for play and inspection; `Search` looks ahead from the
positions of either; `games()` lists the games with their settings and presets.

An observation is a list of tokens with `FIELDS` small integers each (see
`core/gamelab/src/obs.rs`), plus one row per legal action: its verb, up to
three tokens it acts on (`NO_ARG` when unused) and a small parameter.
"""

import json

import numpy as np

from . import _core
from ._core import ACTION_FIELDS, FIELDS, GAME_BLOCK, MAX_SEATS, MAX_STATS, NO_ARG

FIELD_SIZE = tuple(_core.FIELD_SIZE)
#: In `hint`: the game has no hand-written player.
NO_HINT = 0xFFFF

__all__ = [
    "ACTION_FIELDS", "FIELDS", "FIELD_SIZE", "GAME_BLOCK", "MAX_SEATS", "MAX_STATS", "NO_ARG", "NO_HINT",
    "Exact", "Round", "Search", "Tables", "games", "preset", "sample_rules",
]


def games():
    """Every game: id, number, player limits, settings and presets."""
    return json.loads(_core.games())


def preset(game, name=None):
    """A game's named rule set; its default when `name` is None."""
    info = next(g for g in games() if g["id"] == game)
    for label, rules in info["presets"]:
        if name is None or label == name:
            return rules
    raise KeyError(f"{game} has no preset called {name}")


def sample_rules(game, base=None, players=2, seed=0):
    """Rules drawn at random around `base` (the default preset when None)."""
    base = preset(game) if base is None else base
    return json.loads(_core.sample_rules(game, json.dumps(base), players, seed))


def _array(data, dtype, *shape):
    return np.frombuffer(data, dtype=dtype).reshape(*shape) if shape else np.frombuffer(data, dtype=dtype)


def _batch(d):
    n = d["n"]
    return {
        "tokens": _array(d["tokens"], np.uint16, n, d["max_tokens"], FIELDS),
        "token_count": _array(d["token_count"], np.uint16),
        "actions": _array(d["actions"], np.uint16, n, d["max_actions"], ACTION_FIELDS),
        "action_count": _array(d["action_count"], np.uint16),
        "seat": _array(d["seat"], np.uint8),
        "players": _array(d["players"], np.uint8),
        "control": _array(d["control"], np.uint8),
        "game": _array(d["game"], np.uint8),
        "spec": _array(d["spec"], np.uint16),
        # The hand-written player's move (NO_HINT where there is none); empty unless asked for.
        "hint": _array(d["hint"], np.uint16),
    }


class Tables:
    """Many tables played at once.

    `specs` is a list of dicts: `game`, and optionally `rules` (default: the
    game's standard rules), `players` as (fewest, most), `randomize` (share of
    rounds with rules drawn at random around `rules`) and `weight`.

    Each seat of a round has a controller number: 0 for the player being
    trained (one seat chosen at random each round), and for the other seats a
    number drawn with the weights in `league`. `scripted` names the controller
    played by the games' hand-written players (Cabo has one): its seats are
    played inside `step` and never come up in `observe`. At a game without
    such a player those seats go to controller 0.
    """

    def __init__(self, specs, tables, seed=0, step_limit=2000, league=(1.0,), scripted=None):
        self.specs = list(specs)
        self._t = _core.Tables(json.dumps(self.specs), tables, seed, step_limit, list(league), scripted)

    def __len__(self):
        return len(self._t)

    def set_hints(self, hints=True):
        """Add `hint` to what `observe` returns: the move the game's hand-written
        player would make in the seat to move, or NO_HINT."""
        self._t.set_hints(hints)

    def set_league(self, league):
        self._t.set_league(list(league))

    def rules(self, env):
        return json.loads(self._t.rules(env))

    def observe(self, omniscient=False):
        """What the seat to move sees at every table.

        Returns a dict of read-only arrays: `tokens` [n, T, FIELDS] and
        `actions` [n, A, ACTION_FIELDS] (both uint16, zero padded),
        `token_count`, `action_count`, `seat`, `players`, `control`, `game`
        and `spec`, each [n].
        """
        return _batch(self._t.observe(omniscient))

    def search(self, rows, samples=16, seed=0):
        """A `Search` from the tables listed in `rows`."""
        rows = np.ascontiguousarray(rows, dtype="<u4")
        return Search(self._t.search(rows.tobytes(), samples, seed))

    def step(self, actions):
        """Take one action per table (an index into its legal actions).

        Returns the rounds that ended, as arrays with one row each: `env`,
        `spec`, `players`, `steps`, `truncated` (stopped at the step limit,
        returns all zero), `control` [k, MAX_SEATS], `returns` [k, MAX_SEATS]
        and `stats` [k, MAX_STATS] (the game's measurements of the round in
        the order of `games()[..]["stats"]`, NaN beyond them and where one
        does not apply). Those tables have already been dealt again.
        """
        d = self._t.step(np.ascontiguousarray(actions, dtype="<u4").tobytes())
        return {
            "env": _array(d["env"], np.uint32),
            "spec": _array(d["spec"], np.uint32),
            "players": _array(d["players"], np.uint32),
            "steps": _array(d["steps"], np.uint32),
            "truncated": _array(d["truncated"], np.uint32).astype(bool),
            "control": _array(d["control"], np.uint8, -1, MAX_SEATS),
            "returns": _array(d["returns"], np.float32, -1, MAX_SEATS),
            "stats": _array(d["stats"], np.float32, -1, MAX_STATS),
        }


class Round:
    """One round of one game."""

    def __init__(self, game, rules=None, players=2, seed=0, _inner=None):
        if _inner is None:
            rules = preset(game) if rules is None else rules
            _inner = _core.Round(game, json.dumps(rules), players, seed)
        self._r = _inner

    id = property(lambda self: self._r.id)
    players = property(lambda self: self._r.players)
    to_act = property(lambda self: self._r.to_act)
    over = property(lambda self: self._r.over)
    legal = property(lambda self: self._r.legal)

    def rules(self):
        return json.loads(self._r.rules())

    def legal_actions(self):
        """The legal actions as dicts, in the order of the action rows."""
        return json.loads(self._r.legal_json())

    def returns(self):
        return self._r.returns()

    def stats(self):
        """The game's measurements of the finished round, by key."""
        info = next(g for g in games() if g["id"] == self.id)
        return {s["key"]: v for s, v in zip(info["stats"], self._r.stats())}

    def observe(self, seat=None, omniscient=False):
        """(`tokens` [T, FIELDS], `actions` [A, ACTION_FIELDS]) for a seat (default: the seat to move)."""
        d = self._r.observe(self.to_act if seat is None else seat, omniscient)
        return _array(d["tokens"], np.uint16, -1, FIELDS), _array(d["actions"], np.uint16, -1, ACTION_FIELDS)

    def step(self, index):
        self._r.step(int(index))

    def apply(self, seat, action):
        """An action given as a dict, by any seat."""
        self._r.apply(seat, json.dumps(action))

    def determinize(self, seat, seed=0):
        """A round `seat` cannot tell from this one, with the hidden cards dealt again."""
        return Round(None, _inner=self._r.determinize(seat, seed))

    def copy(self):
        return Round(None, _inner=self._r.copy())


class Search:
    """A look ahead from one or more positions.

    The hidden cards of each position are dealt again in `samples` ways the
    seat to move cannot rule out, and every legal action is tried in each:
    one leaf per deal and action. The leaves still in play can be played on
    (`observe`, `step`) before `finish` turns a value for each of them into
    one value per action of each position.
    """

    def __init__(self, inner):
        self._s = inner

    @classmethod
    def of_rounds(cls, rounds, samples=16, seed=0):
        return cls(_core.Search.of_rounds([r._r for r in rounds], samples, seed))

    def __len__(self):
        """Leaves still in play."""
        return len(self._s)

    def observe(self, omniscient=False):
        """What the seat to move sees at each leaf still in play, as `Tables.observe`."""
        return _batch(self._s.observe(omniscient))

    def step(self, actions):
        """Play one more action at each leaf still in play."""
        self._s.step(np.ascontiguousarray(actions, dtype="<u4").tobytes())

    def finish(self, values, scale=()):
        """The value of each action to the seat to move at each position: ([positions, A], deals used).

        `values` [leaves still in play, MAX_SEATS] is each leaf's value for
        every seat, counted from the seat to move there. A leaf whose round
        has ended counts with its result divided by `scale[game number]`.
        """
        values = np.ascontiguousarray(values, dtype="<f4").reshape(-1, MAX_SEATS)
        q, width, samples = self._s.finish(values.tobytes(), [float(x) for x in scale])
        return _array(q, np.float32, -1, width) if width else np.zeros((0, 0), np.float32), _array(samples, np.uint32)


class Exact:
    """A small game written out in full, to score a player with no sampling error.

    `infosets()` gives every decision the game can reach as one batch; give
    `score` the player's move probabilities at each (rows as in the batch) to
    get the value for each seat and the exploitability: what a perfect
    opponent wins per round against it, averaged over the seats. 0 is unbeatable.
    """

    def __init__(self, game, rules=None, players=2, node_limit=20_000_000):
        rules = preset(game) if rules is None else rules
        self._e = _core.Exact(game, json.dumps(rules), players, node_limit)

    positions = property(lambda self: self._e.positions)

    def infosets(self):
        d = self._e.infosets()
        n = d["n"]
        return {
            "tokens": _array(d["tokens"], np.uint16, n, d["max_tokens"], FIELDS),
            "token_count": _array(d["token_count"], np.uint16),
            "actions": _array(d["actions"], np.uint16, n, d["max_actions"], ACTION_FIELDS),
            "action_count": _array(d["action_count"], np.uint16),
            "seat": _array(d["seat"], np.uint8),
        }

    def score(self, probs):
        probs = np.ascontiguousarray(probs, dtype="<f8")
        values, exploitability = self._e.score(probs.tobytes(), probs.shape[1])
        return np.array(values), exploitability

    def solve(self, iterations=1000):
        data, width = self._e.solve(iterations)
        return _array(data, np.float64, -1, width)
