"""Running a network on batches of observations."""

import numpy as np
import torch


def tensor(a, device):
    """A NumPy integer array as an int32 tensor on `device`."""
    return torch.from_numpy(np.ascontiguousarray(a).astype(np.int32)).to(device)


def _rows(obs, rows, keys):
    """The chosen rows of a batch, with the padding they do not need cut off."""
    out = []
    for key, count in keys:
        n = obs[count][rows]
        out += [obs[key][rows, : max(int(n.max()), 1)], n]
    return out


@torch.no_grad()
def scores(net, obs, rows=None, chunk=8192):
    """Move scores [n, A] (log-probabilities) and values [n, seats] for rows of a batch."""
    device = next(net.parameters()).device
    rows = np.arange(len(obs["token_count"])) if rows is None else rows
    width = max(int(obs["action_count"][rows].max()), 1) if len(rows) else 1
    logp, values = [], []
    for i in range(0, len(rows), chunk):
        tok, tc, act, ac = _rows(obs, rows[i : i + chunk], (("tokens", "token_count"), ("actions", "action_count")))
        s, v = net(tensor(tok, device), tensor(tc, device), tensor(act, device), tensor(ac, device))
        s = torch.log_softmax(s, dim=-1)
        logp.append(torch.nn.functional.pad(s, (0, width - s.shape[1]), value=-1e9))
        values.append(v)
    return torch.cat(logp), torch.cat(values)


@torch.no_grad()
def values(net, obs, rows=None, chunk=8192):
    """Values [n, seats], counted from the seat to move."""
    device = next(net.parameters()).device
    rows = np.arange(len(obs["token_count"])) if rows is None else rows
    out = []
    for i in range(0, len(rows), chunk):
        tok, tc = _rows(obs, rows[i : i + chunk], (("tokens", "token_count"),))
        out.append(net(tensor(tok, device), tensor(tc, device))[1])
    return torch.cat(out)


@torch.no_grad()
def choose(net, obs, rows, chunk=8192, greedy=False):
    """A move for each row: (index into the legal actions, its log-probability, all log-probabilities [n, A])."""
    logp, _ = scores(net, obs, rows, chunk)
    pick = logp.argmax(-1) if greedy else torch.distributions.Categorical(logits=logp).sample()
    return pick.cpu().numpy(), logp.gather(1, pick[:, None]).squeeze(1).cpu().numpy(), logp.cpu().numpy()


def probabilities(net, obs, chunk=8192):
    """Move probabilities [n, A] as float64, zero on padding."""
    logp, _ = scores(net, obs, None, chunk)
    return logp.double().exp().cpu().numpy()
