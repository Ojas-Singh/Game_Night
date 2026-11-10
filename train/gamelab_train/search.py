"""Play that looks ahead.

The bare network picks a move from what it sees. `Searcher` first tries every
move in several deals of the hidden cards (see `gamelab.Search`), lets the
value network judge where each leads, and shifts the network's choice towards
the moves that came out ahead:

    new probability  ~  network's probability * exp(value / temperature)

A high temperature leaves the network's play as it is; a low one plays the
best-looking move almost always, which a bluffing game punishes.
"""

from dataclasses import dataclass

import numpy as np
import torch

from .model import Net
from .play import scores, values


@dataclass
class Searcher:
    net: Net
    #: Value network that reads the open position (the judge of training).
    critic: Net
    #: Size of a typical result for each game number, as kept by the trainer.
    scale: np.ndarray
    #: Deals of the hidden cards tried for each position.
    samples: int = 16
    #: Moves played on with `net` after the move being tried, before judging.
    depth: int = 0
    temperature: float = 0.25
    chunk: int = 8192
    seed: int = 0

    @classmethod
    def load(cls, path, device="cpu", **settings):
        """From a checkpoint written by the trainer."""
        state = torch.load(path, map_location="cpu", weights_only=False)
        net = Net.from_dict(state["net"]).to(device).eval()
        critic = Net.from_dict(state["critic"]).to(device).eval()
        return cls(net, critic, np.sqrt(state["square"]).astype(np.float32), **settings)

    def action_values(self, search):
        """([positions, A] value of each move, deals used) for a `gamelab.Search`."""
        for _ in range(self.depth):
            if len(search) == 0:
                break
            logp, _ = scores(self.net, search.observe(), None, self.chunk)
            search.step(torch.distributions.Categorical(logits=logp).sample().cpu().numpy())
        if len(search):
            leaf = values(self.critic, search.observe(omniscient=True), None, self.chunk).cpu().numpy()
        else:
            leaf = np.zeros((0, 0), np.float32)
        return search.finish(leaf, self.scale)

    @torch.no_grad()
    def choose(self, source, obs, rows, greedy=False):
        """A move for each row of `obs`, the batch `source.observe()` gave.

        `source` is a `gamelab.Tables`. Returns (index into the legal actions,
        log-probabilities after the search [n, A], value of each move [n, A]).
        """
        self.seed += 1
        prior, _ = scores(self.net, obs, rows, self.chunk)
        q, _ = self.action_values(source.search(rows, self.samples, self.seed))
        q = torch.tensor(q, device=prior.device)
        q = torch.nn.functional.pad(q, (0, prior.shape[1] - q.shape[1]))
        logp = torch.log_softmax(prior + q / self.temperature, dim=-1)
        pick = logp.argmax(-1) if greedy else torch.distributions.Categorical(logits=logp).sample()
        return pick.cpu().numpy(), logp.cpu().numpy(), q.cpu().numpy()
