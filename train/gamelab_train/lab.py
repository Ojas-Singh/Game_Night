"""The game lab: what a set of rules does to a game.

`measure` plays many rounds under one set of rules and reports what happened:
how each seat fared, how long rounds took, which actions were used and the
game's own measurements (who called Cabo and whether it paid, how many deals a
Seep match took). `compare` does that for several rule sets and lists what
moved by more than chance; `sweep` is `compare` over the values of one setting.

A report says how the *given player* plays the rules. With random moves it
shows little more than the mechanics; conclusions about balance need the
trained player, and the strongest ones the player with search.

    python -m gamelab_train.lab cabo --checkpoint run/latest.pt --sweep startingCards=3,4,5
"""

import argparse
import json

import numpy as np

import gamelab

from .evaluate import act
from .search import Searcher

#: Every seat is played by the same player.
SAME = "same"


def _mean(x):
    """(mean, standard error) of the values that apply, and the share that do."""
    x = np.asarray(x, dtype=np.float64)
    ok = x[~np.isnan(x)]
    if len(ok) == 0:
        return None, None, 0.0
    err = float(ok.std(ddof=1) / np.sqrt(len(ok))) if len(ok) > 1 else None
    return float(ok.mean()), err, len(ok) / len(x)


def measure(game, rules=None, players=2, player=None, opponent=SAME, rounds=2000, tables=512, seed=0,
            step_limit=2000, greedy=False):
    """Play at least `rounds` rounds of `game` under `rules` and report on them.

    `player` is a network, a `Searcher` or None for random moves. It plays
    every seat unless `opponent` is given; then it plays one seat (a different
    one each round) against `opponent` in the others, and the report's
    `player` entry says how it fared.

    The report is plain data (it goes to the lab's pages as JSON):
    `seats` (mean result, share of rounds won outright and shared, for each
    seat in playing order), `spread` (best seat's mean minus the worst's),
    `draws`, `length` (decisions per round), `actions` (how often each verb
    was taken per round, and `taken`: how often when it was on offer) and
    `stats` (the game's own measurements). Every mean comes with its standard
    error under `stderr`.
    """
    info = next(g for g in gamelab.games() if g["id"] == game)
    rules = gamelab.preset(game) if rules is None else {**gamelab.preset(game), **rules}
    spec = {"game": game, "rules": rules, "players": [players, players]}
    t = gamelab.Tables([spec], tables, seed, step_limit, league=(0.0, 1.0))
    rng = np.random.default_rng(seed)
    block = gamelab.GAME_BLOCK
    # Per table, for the round in play: times each verb was taken / on offer.
    taken, offered = np.zeros((tables, block)), np.zeros((tables, block))
    every = np.arange(tables)
    fins, used, seen, cut = [], np.zeros(block), np.zeros(block), 0
    # Every table plays the same number of rounds. Taking the first rounds to
    # finish anywhere would count short rounds too often.
    left = np.full(tables, -(-rounds // tables))
    while left.any():
        obs = t.observe()
        if opponent is SAME:
            actions = np.asarray(act(player, t, obs, every, rng, greedy), dtype=np.uint32)
            counted = every
        else:
            actions = np.zeros(tables, np.uint32)
            counted = np.nonzero(obs["control"] == 0)[0]
            other = np.nonzero(obs["control"] != 0)[0]
            actions[counted] = act(player, t, obs, counted, rng, greedy)
            actions[other] = act(opponent, t, obs, other, rng, greedy)
        verbs = obs["actions"][..., 0] % block
        real = np.arange(verbs.shape[1])[None, :] < obs["action_count"][:, None]
        offer = np.zeros((tables, block), bool)
        offer[np.nonzero(real)[0], verbs[real]] = True
        offered[counted] += offer[counted]
        taken[counted, verbs[counted, actions[counted]]] += 1
        fin = t.step(actions)
        env = fin["env"]
        due = left[env] > 0
        good = due & ~fin["truncated"]
        used += taken[env[good]].sum(0)
        seen += offered[env[good]].sum(0)
        taken[env], offered[env] = 0, 0
        left[env[due]] -= 1
        cut += int((due & fin["truncated"]).sum())
        fins.append({k: v[good] for k, v in fin.items()})
    fin = {k: np.concatenate([f[k] for f in fins]) for k in fins[0]}
    n = len(fin["env"])
    ret = fin["returns"][:, :players].astype(np.float64)
    best = ret.max(1, keepdims=True)
    top = np.isclose(ret, best) & (best > 1e-9)
    alone = top & (top.sum(1, keepdims=True) == 1)

    def entry(x):
        m, e, _ = _mean(x)
        return {"mean": m, "stderr": e}

    seats = [
        {**entry(ret[:, s]), "won": entry(alone[:, s]), "shared": entry(top[:, s] & ~alone[:, s])}
        for s in range(players)
    ]
    means = [s["mean"] for s in seats]
    hi, lo = int(np.argmax(means)), int(np.argmin(means))
    diff = ret[:, hi] - ret[:, lo]
    report = {
        "game": game,
        "rules": rules,
        "players": players,
        "rounds": n,
        "abandoned": cut / (n + cut),
        "seats": seats,
        "spread": {"mean": float(diff.mean()), "stderr": float(diff.std(ddof=1) / np.sqrt(n)), "best": hi, "worst": lo},
        "draws": entry(~top.any(1)),
        "length": {
            **entry(fin["steps"]),
            **{f"p{q}": float(np.percentile(fin["steps"], q)) for q in (10, 50, 90)},
        },
        "actions": [
            {"verb": v, "name": name, "perRound": used[v] / n, "taken": used[v] / seen[v] if seen[v] else None}
            for v, name in info["verbs"]
        ],
        "stats": [],
    }
    for i, stat in enumerate(info["stats"]):
        m, e, share = _mean(fin["stats"][:, i])
        report["stats"].append({**stat, "mean": m, "stderr": e, "applies": share})
    if opponent is not SAME:
        seat = np.argmin(fin["control"][:, :players], axis=1)
        mine = ret[np.arange(n), seat]
        report["player"] = {
            **entry(mine),
            "won": entry(alone[np.arange(n), seat]),
            "seats": [entry(mine[seat == s]) for s in range(players)],
        }
    return report


def numbers(report):
    """Every number of a report with its standard error: {name: (mean, stderr)}."""
    out = {}
    for s, seat in enumerate(report["seats"]):
        out[f"Seat {s + 1}: result"] = (seat["mean"], seat["stderr"])
        out[f"Seat {s + 1}: won outright"] = (seat["won"]["mean"], seat["won"]["stderr"])
    out["Best seat over worst"] = (report["spread"]["mean"], report["spread"]["stderr"])
    out["Draws"] = (report["draws"]["mean"], report["draws"]["stderr"])
    out["Decisions per round"] = (report["length"]["mean"], report["length"]["stderr"])
    if "player" in report:
        out["Player: result"] = (report["player"]["mean"], report["player"]["stderr"])
        out["Player: won outright"] = (report["player"]["won"]["mean"], report["player"]["won"]["stderr"])
    for stat in report["stats"]:
        out[stat["label"]] = (stat["mean"], stat["stderr"])
    for a in report["actions"]:
        out[f"{a['name']}: per round"] = (a["perRound"], None)
    return out


def compare(game, variants, base=None, **settings):
    """`measure` under several rule sets, and what differs between them.

    `variants` maps a name to the settings changed from `base` (the game's
    standard rules when None). The first is the baseline. Returns the reports
    by name and, for every other variant, the numbers that moved: each with
    its value in the baseline and in the variant, the difference and `z`, the
    difference in standard errors (above about 3 it is not chance; None when
    no standard error is known), largest first.
    """
    base = gamelab.preset(game) if base is None else {**gamelab.preset(game), **base}
    reports = {name: measure(game, {**base, **change}, **settings) for name, change in variants.items()}
    names = list(variants)
    first = numbers(reports[names[0]])
    moved = {}
    for name in names[1:]:
        rows = []
        for key, (b, eb) in first.items():
            v, ev = numbers(reports[name]).get(key, (None, None))
            if b is None or v is None:
                continue
            z = None
            if eb is not None and ev is not None and eb + ev > 0:
                z = (v - b) / float(np.hypot(eb, ev))
            rows.append({"name": key, "base": b, "value": v, "change": v - b, "z": z})
        rows.sort(key=lambda r: -abs(r["z"]) if r["z"] is not None else 0.0)
        moved[name] = rows
    return {"game": game, "baseline": names[0], "reports": reports, "changes": moved}


def sweep(game, key, values, base=None, **settings):
    """`compare` over the values of one setting; the first value is the baseline."""
    return compare(game, {f"{key} = {json.dumps(v)}": {key: v} for v in values}, base, **settings)


def _pm(mean, err, digits=3):
    if mean is None:
        return "-"
    return f"{mean:.{digits}f}" + (f" ± {err:.{digits}f}" if err is not None else "")


def text(report):
    """A report as lines of text."""
    r = report
    out = [f"{r['game']}, {r['players']} players, {r['rounds']} rounds"
           + (f" ({r['abandoned']:.1%} abandoned at the step limit)" if r["abandoned"] else "")]
    for s, seat in enumerate(r["seats"]):
        out.append(f"  seat {s + 1}: result {_pm(seat['mean'], seat['stderr'])}, "
                   f"won outright {seat['won']['mean']:.1%}, shared {seat['shared']['mean']:.1%}")
    sp = r["spread"]
    out.append(f"  seat {sp['best'] + 1} over seat {sp['worst'] + 1}: {_pm(sp['mean'], sp['stderr'])}")
    out.append(f"  draws {r['draws']['mean']:.1%}; decisions per round {_pm(r['length']['mean'], r['length']['stderr'], 1)} "
               f"(10% under {r['length']['p10']:.0f}, half under {r['length']['p50']:.0f}, 90% under {r['length']['p90']:.0f})")
    if "player" in r:
        p = r["player"]
        out.append(f"  the player against the others: result {_pm(p['mean'], p['stderr'])}, won outright {p['won']['mean']:.1%}")
    for stat in r["stats"]:
        note = "" if stat["applies"] > 0.999 else f"  (applies to {stat['applies']:.1%} of rounds)"
        out.append(f"  {stat['label']}: {_pm(stat['mean'], stat['stderr'])}{note}")
    for a in r["actions"]:
        if a["taken"] is not None:
            out.append(f"  {a['name']}: {a['perRound']:.2f} per round, taken {a['taken']:.1%} of the times it was possible")
    return "\n".join(out)


def text_changes(result, threshold=3.0):
    """What `compare` found, as lines of text: the numbers that moved by more than chance."""
    out = []
    for name, rows in result["changes"].items():
        out.append(f"{name}  (against {result['baseline']})")
        shown = [r for r in rows if r["z"] is not None and abs(r["z"]) >= threshold]
        for r in shown:
            out.append(f"  {r['name']}: {r['base']:.3f} -> {r['value']:.3f}  ({r['change']:+.3f}, {abs(r['z']):.1f} standard errors)")
        if not shown:
            out.append("  nothing moved by more than chance")
    return "\n".join(out)


def _value(textual):
    try:
        return json.loads(textual)
    except json.JSONDecodeError:
        return textual


def main():
    ap = argparse.ArgumentParser(description="Measure a game under its rules, or compare rule changes.")
    ap.add_argument("game")
    ap.add_argument("--checkpoint", help="trainer checkpoint to play with; random moves when left out")
    ap.add_argument("--search", type=int, default=0, help="deals of the hidden cards to look ahead in (0: no search)")
    ap.add_argument("--preset")
    ap.add_argument("--set", action="append", default=[], metavar="KEY=VALUE", help="change a setting")
    ap.add_argument("--sweep", metavar="KEY=V1,V2,...", help="compare the values of one setting")
    ap.add_argument("--players", type=int, default=None)
    ap.add_argument("--rounds", type=int, default=2000)
    ap.add_argument("--tables", type=int, default=512)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--json", help="write the full result to this file")
    args = ap.parse_args()

    info = next(g for g in gamelab.games() if g["id"] == args.game)
    player = None
    if args.checkpoint:
        player = Searcher.load(args.checkpoint, args.device, samples=max(args.search, 1), seed=args.seed)
        if not args.search:
            player = player.net
    else:
        print("No checkpoint given: the moves are random, so this shows the mechanics, not good play.")
    base = {**gamelab.preset(args.game, args.preset), **{k: _value(v) for k, v in (s.split("=", 1) for s in args.set)}}
    settings = dict(players=args.players or info["minPlayers"], player=player, rounds=args.rounds,
                    tables=args.tables, seed=args.seed)
    if args.sweep:
        key, values = args.sweep.split("=", 1)
        result = sweep(args.game, key, [_value(v) for v in values.split(",")], base, **settings)
        for name, report in result["reports"].items():
            print(f"\n{name}\n{text(report)}")
        print("\n" + text_changes(result))
    else:
        result = measure(args.game, base, **settings)
        print(text(result))
    if args.json:
        with open(args.json, "w") as f:
            json.dump(result, f, indent=1)


if __name__ == "__main__":
    main()
