"""The player: one network for every game and every rule set.

An observation is a set of tokens (cards, players, piles, recent events, the
rules in force), each a row of small integers. Every field has its own
embedding and a token is the sum of its fields. A transformer mixes the
tokens; there is no position encoding because the fields already say where a
thing is.

Moves are scored by pointing: a legal action is a verb, a small parameter and
up to three tokens it acts on, so its score is computed from the verb and the
encodings of those tokens. A game with new verbs or more cards needs no change
to the network.

The value head gives the expected return of every seat, counted from the seat
to move (index 0), so the same head serves games of any number of players.
"""

from dataclasses import asdict, dataclass

import torch
from torch import nn

from gamelab import FIELD_SIZE, MAX_SEATS, NO_ARG

VERBS = FIELD_SIZE[1]  # verbs share the code space of token sub-kinds
PARAMS = 64


@dataclass
class NetConfig:
    width: int = 256
    layers: int = 6
    heads: int = 4
    #: Whether the network scores moves. The training-time judge of positions,
    #: which sees every hidden card, only needs values.
    policy: bool = True


class Block(nn.Module):
    """A transformer layer: attention over the tokens, then a small network on each."""

    def __init__(self, d, heads):
        super().__init__()
        self.heads = heads
        self.norm1 = nn.LayerNorm(d)
        self.qkv = nn.Linear(d, 3 * d)
        self.out = nn.Linear(d, d)
        self.norm2 = nn.LayerNorm(d)
        self.mlp = nn.Sequential(nn.Linear(d, 4 * d), nn.GELU(), nn.Linear(4 * d, d))

    def forward(self, x, real):
        """x [B, T, d]; real [B, 1, 1, T] is False on padding."""
        b, t = x.shape[0], x.shape[1]
        q, k, v = self.qkv(self.norm1(x)).view(b, t, 3, self.heads, -1).permute(2, 0, 3, 1, 4)
        a = nn.functional.scaled_dot_product_attention(q, k, v, attn_mask=real)
        x = x + self.out(a.transpose(1, 2).reshape(b, t, -1))
        return x + self.mlp(self.norm2(x))


class Net(nn.Module):
    def __init__(self, cfg: NetConfig = NetConfig()):
        super().__init__()
        self.cfg = cfg
        d = cfg.width
        self.fields = nn.ModuleList(nn.Embedding(n, d) for n in FIELD_SIZE)
        self.summary = nn.Parameter(torch.zeros(1, 1, d))
        self.blocks = nn.ModuleList(Block(d, cfg.heads) for _ in range(cfg.layers))
        self.norm = nn.LayerNorm(d)
        self.value = nn.Sequential(nn.Linear(d, d), nn.GELU(), nn.Linear(d, MAX_SEATS))
        if cfg.policy:
            self.verb = nn.Embedding(VERBS, d)
            self.param = nn.Embedding(PARAMS, d)
            self.args = nn.ModuleList(nn.Linear(d, d) for _ in range(3))
            self.state = nn.Linear(d, d)
            self.score = nn.Sequential(nn.LayerNorm(d), nn.Linear(d, d), nn.GELU(), nn.Linear(d, 1))
        for emb in self.modules():
            if isinstance(emb, nn.Embedding):
                nn.init.normal_(emb.weight, std=0.02)
        nn.init.zeros_(self.value[-1].weight)
        nn.init.zeros_(self.value[-1].bias)
        if cfg.policy:
            nn.init.zeros_(self.score[-1].weight)
            nn.init.zeros_(self.score[-1].bias)

    def encode(self, tokens, token_count):
        """tokens [B, T, fields] int, token_count [B] -> summary [B, d], encodings [B, T, d]."""
        tokens = tokens.long()
        x = sum(emb(tokens[..., i]) for i, emb in enumerate(self.fields))
        x = torch.cat([self.summary.expand(x.shape[0], -1, -1), x], dim=1)
        length = token_count.long() + 1
        real = (torch.arange(x.shape[1], device=x.device)[None, :] < length[:, None])[:, None, None, :]
        for block in self.blocks:
            x = block(x, real)
        x = self.norm(x)
        return x[:, 0], x[:, 1:]

    def forward(self, tokens, token_count, actions=None, action_count=None):
        """Returns (move scores [B, A] or None, values [B, MAX_SEATS]).

        Scores of padding rows are very negative, so a softmax over the row
        gives the move probabilities.
        """
        summary, enc = self.encode(tokens, token_count)
        values = self.value(summary).float()
        if actions is None or not self.cfg.policy:
            return None, values
        actions = actions.long()
        b, a, d = actions.shape[0], actions.shape[1], enc.shape[-1]
        x = self.verb(actions[..., 0]) + self.param(actions[..., 4].clamp(max=PARAMS - 1))
        x = x + self.state(summary)[:, None, :]
        if enc.shape[1] > 0:
            for i, proj in enumerate(self.args):
                index = actions[..., 1 + i]
                used = index != NO_ARG
                index = index.clamp(max=enc.shape[1] - 1)
                picked = enc.gather(1, index[..., None].expand(b, a, d))
                x = x + proj(picked) * used[..., None]
        scores = self.score(x).squeeze(-1).float()
        real = torch.arange(a, device=scores.device)[None, :] < action_count.long()[:, None]
        return scores.masked_fill(~real, -1e9), values

    def save_dict(self):
        return {"config": asdict(self.cfg), "state": self.state_dict()}

    @staticmethod
    def from_dict(d):
        net = Net(NetConfig(**d["config"]))
        net.load_state_dict(d["state"])
        return net


def seats_from(me, players, device=None):
    """Index [B, MAX_SEATS] turning values counted from the seat to move into table seats.

    `absolute = relative.gather(1, seats_from(me, players))` for seats below
    `players`; and the other way with `seats_to`.
    """
    j = torch.arange(MAX_SEATS, device=device)[None, :]
    return (j - me.long()[:, None]) % players.long()[:, None]


def seats_to(me, players, device=None):
    """Index [B, MAX_SEATS] turning table-seat values into values counted from the seat to move."""
    i = torch.arange(MAX_SEATS, device=device)[None, :]
    return (me.long()[:, None] + i) % players.long()[:, None]
