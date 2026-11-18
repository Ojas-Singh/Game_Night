"""Everything a training run can be told, with the defaults."""

import json
from dataclasses import asdict, dataclass, field


@dataclass
class Config:
    #: The tables to play: a list of `gamelab.Tables` specs (game, rules,
    #: players, randomize, weight). `preset` may name a rule set instead of
    #: giving `rules`.
    specs: list = field(default_factory=list)
    #: Tables played at once and decisions taken at each between two updates.
    tables: int = 2048
    rollout: int = 64
    #: A round still running after this many decisions is abandoned.
    step_limit: int = 2000
    updates: int = 1000

    #: Sizes of the player and of the training-time judge (see model.NetConfig).
    net: dict = field(default_factory=dict)
    critic: dict = field(default_factory=dict)

    lr: float = 3e-4
    critic_lr: float = 3e-4
    warmup: int = 20
    epochs: int = 2
    minibatch: int = 4096
    clip: float = 0.2
    lam: float = 0.95
    value_coef: float = 0.5
    #: Reward for keeping the choice of move open, lowered linearly over the
    #: run. It is what keeps bluffing games from cycling.
    entropy_start: float = 0.05
    entropy_end: float = 0.005
    #: Cost of moving away from the policy that played the rounds (on top of
    #: the hard limit `clip`). Small steps are what make self-play settle
    #: instead of chasing its own tail in games that need bluffing.
    step_cost: float = 5.0
    #: Weight of copying the games' hand-written players (where a game has
    #: one) at the start, lowered linearly to `guide_end` over `guide_updates`
    #: updates. It shows the player moves it would rarely try by itself,
    #: such as throwing out a card that matches the discard.
    guide_start: float = 0.0
    guide_updates: int = 0
    #: Weight kept after `guide_updates`; a small one stops the player from
    #: drifting below the hand-written players while it learns to beat them.
    guide_end: float = 0.0
    #: Rescale advantages to unit spread in every update.
    normalize_advantage: bool = False
    grad_clip: float = 1.0

    #: Opponents. A share of the other seats is played by earlier versions of
    #: the player (`league_slots` of them at a time, drawn from the last
    #: `pool_size` kept, one kept every `snapshot_every` updates) and a small
    #: share by a player that moves at random.
    league_share: float = 0.25
    league_slots: int = 2
    random_share: float = 0.02
    #: Share of the other seats played by the game's hand-written player, at
    #: the games that have one (Cabo). It is an opponent that already plays
    #: sensibly, and the bar the player has to clear.
    bot_share: float = 0.0
    pool_size: int = 16
    snapshot_every: int = 25

    #: Small games scored exactly every `eval_every` updates:
    #: a list of {"game", "preset" or "rules", "players"}.
    exact: list = field(default_factory=list)
    eval_every: int = 25
    save_every: int = 25

    seed: int = 0
    device: str = "cuda"
    #: A minibatch is learned from in pieces of about this many tokens (long
    #: positions count for more), which bounds the GPU memory of an update.
    token_budget: int = 400_000
    #: Half-precision arithmetic on the GPU.
    amp: bool = True
    #: Rows per network call while playing.
    infer_batch: int = 8192

    @staticmethod
    def load(path):
        with open(path) as f:
            return Config(**json.load(f))

    def table_specs(self):
        """`specs` as `gamelab.Tables` takes them, with presets looked up."""
        import gamelab

        out = []
        for spec in self.specs:
            spec = dict(spec)
            if "preset" in spec:
                spec["rules"] = gamelab.preset(spec["game"], spec.pop("preset"))
            out.append(spec)
        return out

    def to_dict(self):
        return asdict(self)
