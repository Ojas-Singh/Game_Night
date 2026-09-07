"""Small CPU policy/value network; optional torch dependency lives here only."""
from __future__ import annotations

from dataclasses import asdict
import json
from pathlib import Path
import torch
from torch import nn

from .backends import ModelBackend, ModelMetadata, RenderedExample
from .gamespec_runtime import RUNTIME_VERSION

RENDERER = 'rulezero-policy-v2'


class CandidateNetwork(nn.Module):
    def __init__(self):
        super().__init__()
        self.embedding = nn.Embedding(257, 16, padding_idx=0)
        self.encoder = nn.GRU(16, 32, batch_first=True)
        self.policy = nn.Sequential(nn.Linear(64, 32), nn.Tanh(), nn.Linear(32, 1))
        self.value = nn.Linear(32, 1)

    def encode(self, text: str):
        data = list(text.encode('utf-8')) or [32]
        if len(data) > 32768:
            raise ValueError('policy input exceeds 32768 bytes')
        tokens = torch.tensor([[x + 1 for x in data]], dtype=torch.long)
        output, _ = self.encoder(self.embedding(tokens))
        # Mean pooling retains the rules and earlier observations as well as
        # the final turn; all inputs are actor-filtered before reaching here.
        return output.mean(dim=1).squeeze(0)

    def forward(self, prompt: str, candidates: list[str]):
        if not candidates:
            raise ValueError('policy requires legal candidates')
        labels = {}
        if '\nACTIONS ' in prompt:
            prefix, raw = prompt.rsplit('\nACTIONS ', 1)
            try:
                labels = {c['candidateId']: c['label'] for c in json.loads(raw)}
            except (ValueError, KeyError, TypeError):
                prefix = prompt
        else:
            prefix = prompt
        context = self.encode(prefix)
        logits = torch.stack([self.policy(torch.cat((context, self.encode(labels.get(c, c))))).squeeze() for c in candidates])
        return logits, self.value(context).squeeze()


class TorchBackend(ModelBackend):
    def __init__(self, seed: int = 0, learning_rate: float = .003):
        torch.set_num_threads(1)
        torch.manual_seed(seed)
        self.seed = seed
        self.learning_rate = learning_rate
        self.network = CandidateNetwork()
        self.optimizer = torch.optim.Adam(self.network.parameters(), lr=learning_rate)
        self.generator = torch.Generator().manual_seed(seed)
        self.steps = 0

    def metadata(self):
        return ModelMetadata('torch-cpu', 'byte-gru-32', RENDERER, self.seed,
                             sdk_version=str(torch.__version__), extra={'runtimeVersion': RUNTIME_VERSION})

    def distribution_value(self, prompt, candidates):
        with torch.no_grad():
            logits, value = self.network(prompt, list(candidates))
            return torch.softmax(logits, 0).tolist(), float(value)

    def probs(self, prompt, candidates):
        return self.distribution_value(prompt, candidates)[0]

    def sample(self, prompt, candidates):
        ps = self.probs(prompt, candidates)
        return candidates[int(torch.multinomial(torch.tensor(ps), 1, generator=self.generator))]

    def train_step(self, examples):
        if not examples:
            return 0.0
        losses = []
        for ex in examples:
            logits, _ = self.network(ex.prompt, list(ex.candidates))
            logp = torch.log_softmax(logits, 0)
            if ex.teacher_probs is not None:
                loss = -(torch.tensor(ex.teacher_probs) * logp).sum()
            else:
                loss = -logp[ex.candidates.index(ex.target)]
            losses.append(loss * ex.weight)
        return self._step(torch.stack(losses).mean())

    def _step(self, loss):
        self.optimizer.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(self.network.parameters(), 1.0)
        self.optimizer.step()
        self.steps += 1
        return float(loss.detach())

    def ppo_step(self, rows, epochs=2):
        if not rows:
            return {'loss': 0.0, 'updates': 0}
        advantages = torch.tensor([r['return'] - r['value'] for r in rows])
        advantages = (advantages - advantages.mean()) / (advantages.std(unbiased=False) + 1e-6)
        losses = []
        for _ in range(epochs):
            for offset in range(0, len(rows), 16):
                batch = []
                for i in range(offset, min(offset + 16, len(rows))):
                    row = rows[i]
                    logits, value = self.network(row['prompt'], row['candidates'])
                    dist = torch.distributions.Categorical(logits=logits)
                    logp = dist.log_prob(torch.tensor(row['chosen']))
                    ratio = torch.exp(logp - row['logProbability'])
                    adv = advantages[i]
                    policy = -torch.minimum(ratio * adv, torch.clamp(ratio, .8, 1.2) * adv)
                    batch.append(policy + .5 * (value - row['return']) ** 2 - .01 * dist.entropy())
                losses.append(self._step(torch.stack(batch).mean()))
        return {'loss': sum(losses) / len(losses), 'updates': len(losses)}

    def save(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        torch.save({'format': 'rulezero-torch/v1', 'metadata': asdict(self.metadata()),
                    'weights': self.network.state_dict(), 'optimizer': self.optimizer.state_dict(),
                    'rng': self.generator.get_state(), 'steps': self.steps,
                    'learningRate': self.learning_rate}, path)

    def load(self, path):
        data = torch.load(path, map_location='cpu', weights_only=True)
        if data['format'] != 'rulezero-torch/v1' or data['metadata']['renderer'] != RENDERER or data['metadata']['extra']['runtimeVersion'] != RUNTIME_VERSION:
            raise ValueError('incompatible checkpoint')
        self.network.load_state_dict(data['weights'])
        self.optimizer.load_state_dict(data['optimizer'])
        self.generator.set_state(data['rng'])
        self.seed = data['metadata']['seed']
        self.steps = data['steps']

    def clone(self):
        from copy import deepcopy
        clone = TorchBackend(self.seed, self.learning_rate)
        clone.network.load_state_dict(deepcopy(self.network.state_dict()))
        clone.generator.set_state(self.generator.get_state())
        return clone
