"""Self-play training.

Many tables are played at once. The player moves in every seat (and, for a
share of the seats, an earlier version of itself or a random player does);
after a fixed number of decisions the player is improved on what its own
seats did, and play goes on from where it stopped.

How good a move was is judged by a second network that is only used here: it
sees every hidden card, so its judgement of a position is far less noisy than
the final result of the round. The player never sees what the judge sees.

    python -m gamelab_train.train --config configs/all.json --out runs/all
"""

import argparse
import copy
import json
import os
import time

import numpy as np
import torch
from torch.nn import functional as F

import gamelab
from gamelab import MAX_SEATS

from .config import Config
from .evaluate import exploitability
from .model import Net, NetConfig, seats_from, seats_to
from .play import choose, tensor, values
from .storage import Ragged

GAMES = 16


def advantages(value, ret, done, cut, lam):
    """How much better each seat did than the judge expected, for every step.

    value [T+1, N, S] is the judge's value for every seat before each step and
    after the last; ret [T, N, S] the result of a round that ended at a step;
    done and cut [T, N] say where a round ended and where it was abandoned.
    Returns advantages [T, N, S]; `value[:-1] + advantages` are the targets.
    """
    adv = np.zeros_like(ret)
    run = np.zeros_like(ret[0])
    for t in reversed(range(len(ret))):
        end = np.where(cut[t][:, None], value[t], ret[t])
        after = np.where(done[t][:, None], end, value[t + 1])
        run = after - value[t] + lam * np.where(done[t][:, None], 0.0, run)
        adv[t] = run
    return adv


class Trainer:
    def __init__(self, cfg: Config, out=None):
        self.cfg, self.out = cfg, out
        self.device = torch.device(cfg.device if cfg.device != "cuda" or torch.cuda.is_available() else "cpu")
        torch.manual_seed(cfg.seed)
        self.rng = np.random.default_rng(cfg.seed)
        self.net = Net(NetConfig(**cfg.net)).to(self.device)
        self.critic = Net(NetConfig(**{**cfg.critic, "policy": False})).to(self.device)
        self.opt = torch.optim.AdamW(self.net.parameters(), lr=cfg.lr, weight_decay=0.0)
        self.critic_opt = torch.optim.AdamW(self.critic.parameters(), lr=cfg.critic_lr, weight_decay=0.0)
        # Earlier versions of the player: the ones kept, and the ones at the tables.
        self.pool = [self._weights()]
        self.slots = [copy.deepcopy(self.net).eval().requires_grad_(False) for _ in range(cfg.league_slots)]
        self.random_id = 1 + cfg.league_slots
        past = cfg.league_share if cfg.league_slots else 0.0
        # The hand-written player's seats are played inside the tables.
        self.bot_id = self.random_id + 1
        own = 1.0 - past - cfg.random_share - cfg.bot_share
        league = [own] + [past / max(cfg.league_slots, 1)] * cfg.league_slots + [cfg.random_share, cfg.bot_share]
        self.tables = gamelab.Tables(
            cfg.table_specs(), cfg.tables, cfg.seed, cfg.step_limit, league, scripted=self.bot_id if cfg.bot_share else None
        )
        # Results are divided by their usual size in each game, so that a game
        # played for chips and one played for a win count the same.
        self.square = np.ones(GAMES)
        self.seen = np.zeros(GAMES)
        self.update = 0
        self.decisions = 0

    # -- state -------------------------------------------------------------

    def _weights(self):
        return {k: v.detach().cpu().clone() for k, v in self.net.state_dict().items()}

    def scale(self):
        return np.sqrt(self.square).astype(np.float32)

    def save(self, path):
        state = {
            "config": self.cfg.to_dict(),
            "net": self.net.save_dict(),
            "critic": self.critic.save_dict(),
            "opt": self.opt.state_dict(),
            "critic_opt": self.critic_opt.state_dict(),
            "pool": self.pool,
            "square": self.square,
            "seen": self.seen,
            "update": self.update,
            "decisions": self.decisions,
        }
        torch.save(state, path + ".tmp")
        os.replace(path + ".tmp", path)

    def load(self, path):
        state = torch.load(path, map_location="cpu", weights_only=False)
        self.net.load_state_dict(state["net"]["state"])
        self.critic.load_state_dict(state["critic"]["state"])
        self.opt.load_state_dict(state["opt"])
        self.critic_opt.load_state_dict(state["critic_opt"])
        self.pool = state["pool"]
        self.square, self.seen = state["square"], state["seen"]
        self.update, self.decisions = state["update"], state["decisions"]

    # -- play --------------------------------------------------------------

    def _judge(self, omni):
        """The judge's value for every table seat [N, S]."""
        rel = values(self.critic, omni, chunk=self.cfg.infer_batch)
        index = seats_from(tensor(omni["seat"], self.device), tensor(omni["players"], self.device), self.device)
        return rel.gather(1, index).cpu().numpy()

    def collect(self):
        cfg, t = self.cfg, self.tables
        n, steps = len(t), cfg.rollout
        for slot in self.slots:
            slot.load_state_dict(self.pool[self.rng.integers(len(self.pool))])
        value = np.zeros((steps + 1, n, MAX_SEATS), np.float32)
        ret = np.zeros((steps, n, MAX_SEATS), np.float32)
        done = np.zeros((steps, n), bool)
        cut = np.zeros((steps, n), bool)
        seat = np.zeros((steps, n), np.int64)
        players = np.zeros((steps, n), np.int64)
        d = {"omni": Ragged(), "tokens": Ragged(), "actions": Ragged(), "old": Ragged(), "step": [], "table": [], "choice": [], "logp": []}
        stats = {"rounds": np.zeros(GAMES), "length": np.zeros(GAMES), "cut": np.zeros(GAMES)}
        # Mean result of the player's seat against each kind of opponent.
        against = {"past": [], "random": [], "bot": []}
        self.net.eval()
        for s in range(steps):
            obs, omni = t.observe(False), t.observe(True)
            value[s] = self._judge(omni)
            d["omni"].add(omni["tokens"], omni["token_count"])
            seat[s], players[s] = obs["seat"], obs["players"]
            actions = np.zeros(n, np.uint32)
            for c in np.unique(obs["control"]):
                rows = np.nonzero(obs["control"] == c)[0]
                if c == self.random_id:
                    actions[rows] = self.rng.integers(0, obs["action_count"][rows])
                    continue
                net = self.net if c == 0 else self.slots[c - 1]
                actions[rows], logp, logp_all = choose(net, obs, rows, cfg.infer_batch)
                if c == 0:
                    d["old"].add(logp_all[:, :, None], obs["action_count"][rows])
                    d["tokens"].add(obs["tokens"][rows], obs["token_count"][rows])
                    d["actions"].add(obs["actions"][rows], obs["action_count"][rows])
                    d["step"].append(np.full(len(rows), s))
                    d["table"].append(rows)
                    d["choice"].append(actions[rows].astype(np.int64))
                    d["logp"].append(logp)
            game = obs["game"].astype(np.int64)
            fin = t.step(actions)
            self._finished(fin, game, s, ret, done, cut, stats, against)
        value[steps] = self._judge(t.observe(True))
        for key in ("omni", "tokens", "actions", "old"):
            d[key].close()
        for key in ("step", "table", "choice", "logp"):
            d[key] = np.concatenate(d[key])
        adv = advantages(value, ret, done, cut, cfg.lam)
        d.update(value=value[:-1], adv=adv, seat=seat, players=players, stats=stats, against=against)
        self.decisions += steps * n
        return d

    def _finished(self, fin, game, s, ret, done, cut, stats, against):
        env = fin["env"].astype(np.int64)
        if not len(env):
            return
        g = game[env]
        ok = ~fin["truncated"]
        real = np.arange(MAX_SEATS)[None, :] < fin["players"][:, None]
        # Keep the usual size of a result in each game up to date.
        for k in np.unique(g[ok]):
            r = fin["returns"][ok & (g == k)][real[ok & (g == k)]]
            self.seen[k] += len(r)
            self.square[k] += (np.mean(r**2) - self.square[k]) * max(len(r) / self.seen[k], 1e-3)
            self.square[k] = max(self.square[k], 1e-6)
        scaled = fin["returns"] / self.scale()[g][:, None]
        done[s, env] = True
        cut[s, env] = fin["truncated"]
        ret[s, env] = scaled
        np.add.at(stats["rounds"], g, 1)
        np.add.at(stats["length"], g, fin["steps"])
        np.add.at(stats["cut"], g, fin["truncated"])
        control = np.where(real, fin["control"], 0)
        mine = scaled[np.arange(len(env)), np.argmin(control, axis=1)]
        top = control.max(axis=1)
        against["random"] += list(mine[ok & (top == self.random_id) & ((control == 0).sum(1) == MAX_SEATS - 1)])
        against["past"] += list(mine[ok & (top > 0) & (top < self.random_id)])
        against["bot"] += list(mine[ok & (top == self.bot_id) & ((control == 0).sum(1) == MAX_SEATS - 1)])

    # -- learning ----------------------------------------------------------

    def _batches(self, count):
        order = self.rng.permutation(count)
        return [order[i : i + self.cfg.minibatch] for i in range(0, count, self.cfg.minibatch)]

    def _chunks(self, rows, lengths):
        """Split a minibatch into pieces that fit the GPU: rows sorted by length,
        each piece within `token_budget`. Their gradients are added up, so the
        update is the same as for the whole minibatch at once."""
        rows = rows[np.argsort(lengths[rows], kind="stable")]
        n = lengths[rows].astype(np.float64) + 1
        cost = n * (1 + n / 256)
        start = 0
        while start < len(rows):
            end = start + 1
            while end < len(rows) and cost[end] * (end + 1 - start) <= self.cfg.token_budget:
                end += 1
            yield rows[start:end]
            start = end

    def _autocast(self):
        return torch.autocast("cuda", dtype=torch.bfloat16, enabled=self.cfg.amp and self.device.type == "cuda")

    def _targets(self, d, step, table):
        """Targets counted from the seat to move, and which entries are real seats."""
        dev = self.device
        target = torch.from_numpy(d["value"][step, table] + d["adv"][step, table]).to(dev)
        me, n = tensor(d["seat"][step, table], dev), tensor(d["players"][step, table], dev)
        real = torch.arange(MAX_SEATS, device=dev)[None, :] < n[:, None]
        return target.gather(1, seats_to(me, n, dev)), real

    def learn(self, d):
        cfg, dev = self.cfg, self.device
        progress = min(self.update / max(cfg.updates - 1, 1), 1.0)
        entropy_coef = cfg.entropy_start + (cfg.entropy_end - cfg.entropy_start) * progress
        warm = min((self.update + 1) / max(cfg.warmup, 1), 1.0)
        for opt, lr in ((self.opt, cfg.lr), (self.critic_opt, cfg.critic_lr)):
            for group in opt.param_groups:
                group["lr"] = lr * warm

        adv = d["adv"][d["step"], d["table"], d["seat"][d["step"], d["table"]]]
        if cfg.normalize_advantage:
            adv = (adv - adv.mean()) / (adv.std() + 1e-8)
        log = {k: [] for k in ("policy", "value", "entropy", "kl", "clipped", "judge")}
        self.net.train()
        for _ in range(cfg.epochs):
            for batch in self._batches(len(adv)):
                seats = float(d["players"][d["step"][batch], d["table"][batch]].sum())
                part = {k: 0.0 for k in ("policy", "value", "entropy", "kl", "clipped")}
                self.opt.zero_grad(set_to_none=True)
                for rows in self._chunks(batch, d["tokens"].len):
                    share = len(rows) / len(batch)
                    tok, tc = d["tokens"].take(rows)
                    act, ac = d["actions"].take(rows)
                    with self._autocast():
                        scores, value = self.net(tensor(tok, dev), tensor(tc, dev), tensor(act, dev), tensor(ac, dev))
                    logp_all = torch.log_softmax(scores, dim=-1)
                    logp = logp_all.gather(1, torch.from_numpy(d["choice"][rows]).to(dev)[:, None]).squeeze(1)
                    old = torch.from_numpy(d["logp"][rows]).to(dev)
                    a = torch.from_numpy(adv[rows]).to(dev)
                    ratio = (logp - old).exp()
                    policy = -torch.minimum(ratio * a, ratio.clamp(1 - cfg.clip, 1 + cfg.clip) * a).mean() * share
                    entropy = -(logp_all.exp() * logp_all).sum(-1).mean() * share
                    target, real = self._targets(d, d["step"][rows], d["table"][rows])
                    vloss = (F.smooth_l1_loss(value, target, reduction="none") * real).sum() / seats
                    loss = policy - entropy_coef * entropy + cfg.value_coef * vloss
                    if cfg.step_cost:
                        before = torch.from_numpy(d["old"].take(rows)[0][:, :, 0]).to(dev)
                        moved = (logp_all.exp() * (logp_all - before)).sum(-1).mean() * share
                        loss = loss + cfg.step_cost * moved
                    loss.backward()
                    part["policy"] += policy.item()
                    part["value"] += vloss.item()
                    part["entropy"] += entropy.item()
                    part["kl"] += (old - logp).mean().item() * share
                    part["clipped"] += ((ratio - 1).abs() > cfg.clip).float().mean().item() * share
                torch.nn.utils.clip_grad_norm_(self.net.parameters(), cfg.grad_clip)
                self.opt.step()
                for k, v in part.items():
                    log[k].append(v)

        self.critic.train()
        steps, n = d["seat"].shape
        for _ in range(cfg.epochs):
            for batch in self._batches(steps * n):
                seats = float(d["players"].reshape(-1)[batch].sum())
                total = 0.0
                self.critic_opt.zero_grad(set_to_none=True)
                for rows in self._chunks(batch, d["omni"].len):
                    tok, tc = d["omni"].take(rows)
                    with self._autocast():
                        _, value = self.critic(tensor(tok, dev), tensor(tc, dev))
                    target, real = self._targets(d, rows // n, rows % n)
                    loss = (F.smooth_l1_loss(value, target, reduction="none") * real).sum() / seats
                    loss.backward()
                    total += loss.item()
                torch.nn.utils.clip_grad_norm_(self.critic.parameters(), cfg.grad_clip)
                self.critic_opt.step()
                log["judge"].append(total)
        self.critic.eval()
        self.net.eval()

        self.update += 1
        if self.update % cfg.snapshot_every == 0:
            self.pool.append(self._weights())
            if len(self.pool) > cfg.pool_size:
                # Keep the newest and a spread of older ones.
                self.pool.pop(int(self.rng.integers(len(self.pool) - 1)))
        out = {k: float(np.mean(v)) for k, v in log.items()}
        out["entropy_coef"] = entropy_coef
        return out

    # -- the run -----------------------------------------------------------

    def evaluate(self):
        out = {}
        for e in self.cfg.exact:
            rules = e.get("rules") or gamelab.preset(e["game"], e.get("preset"))
            _, x = exploitability(self.net, e["game"], rules, e.get("players", 2))
            out[e.get("preset") or e["game"]] = x
        return out

    def step(self):
        """Play, learn, and return one line for the log."""
        start = time.time()
        d = self.collect()
        played = time.time() - start
        line = {"update": self.update + 1, "decisions": self.decisions, **self.learn(d)}
        names = {g["number"]: g["id"] for g in gamelab.games()}
        rounds = d["stats"]["rounds"]
        line["games"] = {
            names[k]: {
                "rounds": int(rounds[k]),
                "length": round(d["stats"]["length"][k] / rounds[k], 1),
                "abandoned": round(d["stats"]["cut"][k] / rounds[k], 4),
                "scale": round(float(self.scale()[k]), 4),
            }
            for k in np.nonzero(rounds)[0]
        }
        for who, results in d["against"].items():
            if results:
                line["vs_" + who] = round(float(np.mean(results)), 4)
        line["play_seconds"] = round(played, 2)
        line["seconds"] = round(time.time() - start, 2)
        line["decisions_per_second"] = round(len(d["omni"]) / line["seconds"])
        if self.cfg.exact and self.update % self.cfg.eval_every == 0:
            line["exploitability"] = self.evaluate()
        return line

    def run(self):
        log = None
        if self.out:
            os.makedirs(self.out, exist_ok=True)
            latest = os.path.join(self.out, "latest.pt")
            if os.path.exists(latest):
                self.load(latest)
                print(f"resumed at update {self.update}", flush=True)
            else:
                with open(os.path.join(self.out, "config.json"), "w") as f:
                    json.dump(self.cfg.to_dict(), f, indent=1)
            log = open(os.path.join(self.out, "log.jsonl"), "a")
        while self.update < self.cfg.updates:
            line = self.step()
            print(json.dumps(line), flush=True)
            if log:
                log.write(json.dumps(line) + "\n")
                log.flush()
                if self.update % self.cfg.save_every == 0 or self.update == self.cfg.updates:
                    self.save(os.path.join(self.out, "latest.pt"))


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--config", required=True)
    p.add_argument("--out", required=True, help="folder for the checkpoint and the log; an existing run is continued")
    p.add_argument("--device")
    a = p.parse_args()
    cfg = Config.load(a.config)
    if a.device:
        cfg.device = a.device
    Trainer(cfg, a.out).run()


if __name__ == "__main__":
    main()
