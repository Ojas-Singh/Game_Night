"""Measuring a player.

`exploitability` is exact and only possible for small games: it is what a
perfect opponent wins per round. `versus` plays rounds of any game against a
given opponent and reports the player's mean result.
"""

import numpy as np

import gamelab

from .play import choose, probabilities
from .search import Searcher


def exploitability(net, game, rules=None, players=2):
    """(value for each seat, exploitability) of `net` in a small game, in the game's own units."""
    exact = gamelab.Exact(game, rules, players)
    return exact.score(probabilities(net, exact.infosets()))


def act(player, tables, obs, rows, rng, greedy=False):
    """A move at each of `rows` of `obs` (what `tables.observe()` gave) by
    `player`: a network, a `Searcher`, or None for random moves."""
    if len(rows) == 0:
        return np.zeros(0, np.uint32)
    if player is None:
        return rng.integers(0, obs["action_count"][rows])
    if isinstance(player, Searcher):
        return player.choose(tables, obs, rows, greedy=greedy)[0]
    return choose(player, obs, rows, greedy=greedy)[0]


def versus(net, opponent, specs, rounds=2000, tables=512, seed=0, step_limit=2000, greedy=False):
    """Play `net` in one seat against `opponent` in the others.

    Each is a network, a `Searcher` (a network that looks ahead), or None for
    random moves. The opponent may also be "bot", the game's hand-written
    player (for the games that have one).

    Returns one dict per spec: rounds played, the player's mean return, its
    standard error, mean decisions per round and the share of rounds abandoned
    at the step limit.
    """
    bot = isinstance(opponent, str)
    if bot and opponent != "bot":
        raise ValueError(f"unknown opponent {opponent}")
    t = gamelab.Tables(specs, tables, seed, step_limit, league=(0.0, 1.0), scripted=1 if bot else None)
    rng = np.random.default_rng(seed)
    got = [[] for _ in specs]
    steps = [[] for _ in specs]
    cut = [0] * len(specs)
    # Every table gives the same number of rounds: taking the first rounds to
    # finish anywhere would count short rounds too often.
    left = np.zeros(tables, np.int64)
    while True:
        if not left.any():
            short = rounds - min(len(g) for g in got)
            if short <= 0:
                break
            left[:] = -(-short * len(specs) // tables)
        obs = t.observe()
        actions = np.zeros(len(t), np.uint32)
        mine = np.nonzero(obs["control"] == 0)[0]
        other = np.nonzero(obs["control"] != 0)[0]
        actions[mine] = act(net, t, obs, mine, rng, greedy)
        if bot and len(other):
            raise ValueError("one of the games has no hand-written player")
        actions[other] = act(opponent, t, obs, other, rng, greedy)
        fin = t.step(actions)
        for i in range(len(fin["env"])):
            s, env = fin["spec"][i], fin["env"][i]
            if left[env] <= 0:
                continue
            left[env] -= 1
            if fin["truncated"][i]:
                cut[s] += 1
                continue
            seat = int(np.argmin(fin["control"][i, : fin["players"][i]]))
            got[s].append(fin["returns"][i, seat])
            steps[s].append(fin["steps"][i])
    out = []
    for s, spec in enumerate(specs):
        g = np.array(got[s], dtype=np.float64)
        out.append({
            "game": spec["game"],
            "rounds": len(g),
            "mean": float(g.mean()),
            "stderr": float(g.std(ddof=1) / np.sqrt(len(g))),
            "steps": float(np.mean(steps[s])),
            "abandoned": cut[s] / (len(g) + cut[s]),
        })
    return out
