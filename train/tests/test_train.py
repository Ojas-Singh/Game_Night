import numpy as np
import torch

import gamelab
from gamelab_train.config import Config
from gamelab_train.evaluate import exploitability, versus
from gamelab_train.model import Net, NetConfig, seats_from, seats_to
from gamelab_train.storage import Ragged
from gamelab_train.train import Trainer, advantages

SMALL = {"width": 32, "layers": 1, "heads": 2}


def test_ragged_round_trip():
    rng = np.random.default_rng(0)
    r, rows = Ragged(), []
    for _ in range(3):
        counts = rng.integers(0, 7, size=5)
        padded = rng.integers(1, 100, size=(5, 8, 3)).astype(np.uint16)
        r.add(padded, counts)
        rows += [padded[i, :c] for i, c in enumerate(counts)]
    r.close()
    pick = rng.permutation(len(rows))[:9]
    out, n = r.take(pick)
    for i, j in enumerate(pick):
        assert n[i] == len(rows[j])
        assert (out[i, : n[i]] == rows[j]).all() and (out[i, n[i] :] == 0).all()


def test_seat_indices_undo_each_other():
    me, n = torch.tensor([0, 2, 3]), torch.tensor([2, 3, 6])
    table = torch.arange(8.0).repeat(3, 1) + 10
    rel = table.gather(1, seats_to(me, n))
    assert rel[1, 0] == 12 and rel[1, 1] == 10 and rel[2, 3] == 10
    back = rel.gather(1, seats_from(me, n))
    for i, k in enumerate(n):
        assert (back[i, :k] == table[i, :k]).all()


def test_advantages_follow_the_result():
    # One table, one seat of interest; the round ends at step 1 with result 1,
    # then a new round starts whose values must not leak backwards.
    value = np.zeros((4, 1, 8), np.float32)
    value[:, 0, 0] = [0.2, 0.6, -0.5, -0.5]
    ret = np.zeros((3, 1, 8), np.float32)
    ret[1, 0, 0] = 1.0
    done = np.array([[False], [True], [False]])
    cut = np.zeros((3, 1), bool)
    adv = advantages(value, ret, done, cut, lam=1.0)
    assert np.allclose(adv[:, 0, 0], [0.8, 0.4, 0.0])
    adv = advantages(value, ret, done, cut, lam=0.0)
    assert np.allclose(adv[:, 0, 0], [0.4, 0.4, 0.0])
    # An abandoned round teaches nothing at its last step.
    adv = advantages(value, ret, done, np.array([[False], [True], [False]]), lam=1.0)
    assert np.allclose(adv[:, 0, 0], [0.4, 0.0, 0.0])


def test_padding_does_not_change_the_answer():
    torch.manual_seed(0)
    net = Net(NetConfig(**SMALL)).eval()
    for p in net.parameters():
        torch.nn.init.normal_(p, std=0.3)
    t = gamelab.Tables([{"game": "cabo"}], 6, seed=1)
    obs = t.observe()
    tok, act = torch.from_numpy(obs["tokens"].astype(np.int32)), torch.from_numpy(obs["actions"].astype(np.int32))
    tc, ac = torch.from_numpy(obs["token_count"].astype(np.int32)), torch.from_numpy(obs["action_count"].astype(np.int32))
    s, v = net(tok, tc, act, ac)
    wide_t = torch.nn.functional.pad(tok, (0, 0, 0, 9), value=3)
    wide_a = torch.nn.functional.pad(act, (0, 0, 0, 4), value=1)
    s2, v2 = net(wide_t, tc, wide_a, ac)
    assert torch.allclose(v, v2, atol=1e-4)
    assert torch.allclose(s, s2[:, : s.shape[1]], atol=1e-4)
    assert (s2[:, s.shape[1] :] < -1e8).all()


def config(**kw):
    base = dict(
        specs=[{"game": "minipoker", "rules": gamelab.preset("minipoker", "Kuhn poker")}],
        tables=256, rollout=8, updates=3, net=SMALL, critic=SMALL, minibatch=512, device="cpu",
        snapshot_every=1, eval_every=1, exact=[{"game": "minipoker", "preset": "Kuhn poker"}],
    )
    return Config(**{**base, **kw})


def test_all_games_train_and_resume(tmp_path):
    specs = [
        {"game": "cabo", "randomize": 0.5},
        {"game": "seep", "randomize": 0.5},
        {"game": "pairone", "rules": {"ranks": 4, "copies": 2, "extraTurn": True}, "players": [2, 3]},
        {"game": "minipoker", "randomize": 0.5, "players": [2, 3]},
    ]
    out = str(tmp_path / "run")
    t = Trainer(config(specs=specs, tables=64, exact=[], updates=2), out)
    t.run()
    assert t.update == 2 and len(t.pool) == 3
    again = Trainer(config(specs=specs, tables=64, exact=[], updates=3), out)
    again.run()
    assert again.update == 3
    lines = open(tmp_path / "run" / "log.jsonl").read().splitlines()
    assert len(lines) == 3 and all(np.isfinite(__import__("json").loads(l)["policy"]) for l in lines)


def test_versus_reports_every_spec():
    net = Net(NetConfig(**SMALL)).eval()
    out = versus(net, None, [{"game": "minipoker"}, {"game": "pairone", "rules": {"ranks": 3, "copies": 2, "extraTurn": True}}], rounds=50, tables=32)
    assert [o["game"] for o in out] == ["minipoker", "pairone"] and all(o["rounds"] >= 50 for o in out)


def test_untrained_player_is_as_exploitable_as_uniform():
    net = Net(NetConfig(**SMALL)).eval()
    _, x = exploitability(net, "minipoker", gamelab.preset("minipoker", "Kuhn poker"))
    assert abs(x - 0.4583) < 1e-3


def test_search_values_and_play(tmp_path):
    import gamelab
    from gamelab_train.search import Searcher

    torch.manual_seed(0)
    net = Net(NetConfig(width=32, layers=1, heads=2))
    critic = Net(NetConfig(width=32, layers=1, heads=2, policy=False))
    scale = np.full(16, 2.0, np.float32)

    # Facing a bet in Kuhn poker both answers end the round, so the values are exact.
    r = gamelab.Round("minipoker", gamelab.preset("minipoker", "Kuhn poker"), 2, seed=1)
    r.step([a["type"] for a in r.legal_actions()].index("BET"))
    kinds = [a["type"] for a in r.legal_actions()]
    s = Searcher(net, critic, scale, samples=8)
    q, used = s.action_values(gamelab.Search.of_rounds([r], 8))
    assert used.tolist() == [8] and q[0, kinds.index("FOLD")] == -0.5

    specs = [{"game": "cabo"}, {"game": "seep"}, {"game": "minipoker", "players": [2, 3]}]
    for depth in (0, 2):
        s = Searcher(net, critic, scale, samples=2, depth=depth)
        out = versus(s, net, specs, rounds=8, tables=24, step_limit=400)
        assert all(o["rounds"] >= 8 for o in out)


def test_export_matches(tmp_path):
    from gamelab_train.export import export

    torch.manual_seed(0)
    net = Net(NetConfig(**SMALL))
    critic = Net(NetConfig(**SMALL, policy=False))
    for p in list(net.parameters()) + list(critic.parameters()):
        if p.dim() > 1:
            torch.nn.init.normal_(p, std=0.3)
    assert export(net, critic, np.ones(16), str(tmp_path)) < 1e-3


def test_lab_reports():
    from gamelab_train import lab

    r = lab.measure("cabo", players=3, rounds=64, tables=32)
    assert r["rounds"] >= 64 and len(r["seats"]) == 3
    assert abs(sum(s["mean"] for s in r["seats"])) < 1e-6
    stats = {s["key"]: s for s in r["stats"]}
    assert stats["turns"]["mean"] > 0 and 0 <= stats["callerWon"]["mean"] <= 1
    draws = {a["name"]: a for a in r["actions"]}["Draw"]
    # A turn starts with a draw and nothing else is possible then.
    assert draws["taken"] == 1.0 and abs(draws["perRound"] - stats["turns"]["mean"]) < 1e-6
    assert lab.text(r)

    torch.manual_seed(0)
    net = Net(NetConfig(**SMALL)).eval()
    kuhn = gamelab.preset("minipoker", "Kuhn poker")
    r = lab.measure("minipoker", kuhn, player=net, opponent=None, rounds=200, tables=64)
    assert len(r["player"]["seats"]) == 2 and r["player"]["stderr"] > 0

    c = lab.sweep("minipoker", "ante", [1, 3], base=kuhn, rounds=1500, tables=128)
    (rows,) = c["changes"].values()
    pot = next(row for row in rows if row["name"] == "Pot")
    assert pot["change"] > 3 and pot["z"] > 5
    assert "Pot" in lab.text_changes(c)
