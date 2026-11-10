"""Write a trained player as ONNX files, for the site and other programs.

    python -m gamelab_train.export runs/all/latest.pt site-model/

writes `player.onnx` (what a seat sees -> move scores and values),
`judge.onnx` (the open position -> values, for looking ahead) and
`model.json` (sizes, and the typical result of each game that the values are
measured in). All inputs are int32; batch, token and action counts are free.
"""

import argparse
import json
import os

import numpy as np
import torch

import gamelab

from .model import Net


class _Player(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, tokens, token_count, actions, action_count):
        scores, values = self.net(tokens, token_count, actions, action_count)
        return torch.log_softmax(scores, dim=-1), values


class _Judge(torch.nn.Module):
    def __init__(self, net):
        super().__init__()
        self.net = net

    def forward(self, tokens, token_count):
        return self.net(tokens, token_count)[1]


def _sample(batch, tokens, actions):
    g = torch.Generator().manual_seed(batch * 1000 + tokens)
    tok = torch.stack([torch.randint(0, n, (batch, tokens), generator=g) for n in gamelab.FIELD_SIZE], dim=-1).int()
    tc = torch.randint(1, tokens + 1, (batch,), generator=g).int()
    act = torch.zeros(batch, actions, gamelab.ACTION_FIELDS, dtype=torch.int32)
    act[..., 0] = torch.randint(0, gamelab.FIELD_SIZE[1], (batch, actions), generator=g)
    act[..., 1:4] = torch.randint(0, tokens, (batch, actions, 3), generator=g)
    act[..., 3] = gamelab.NO_ARG
    act[..., 4] = torch.randint(0, 64, (batch, actions), generator=g)
    ac = torch.randint(1, actions + 1, (batch,), generator=g).int()
    return tok, tc, act, ac


def export(net, critic, scale, out, check=True):
    """Write the three files into the directory `out`; returns the largest difference from PyTorch seen."""
    os.makedirs(out, exist_ok=True)
    net, critic = net.cpu().eval(), critic.cpu().eval()
    tok, tc, act, ac = _sample(3, 7, 5)
    axes = {"tokens": {0: "batch", 1: "tokens"}, "token_count": {0: "batch"}}
    torch.onnx.export(
        _Player(net), (tok, tc, act, ac), os.path.join(out, "player.onnx"), dynamo=False, opset_version=17,
        input_names=["tokens", "token_count", "actions", "action_count"], output_names=["scores", "values"],
        dynamic_axes={**axes, "actions": {0: "batch", 1: "actions"}, "action_count": {0: "batch"},
                      "scores": {0: "batch", 1: "actions"}, "values": {0: "batch"}},
    )
    torch.onnx.export(
        _Judge(critic), (tok, tc), os.path.join(out, "judge.onnx"), dynamo=False, opset_version=17,
        input_names=["tokens", "token_count"], output_names=["values"],
        dynamic_axes={**axes, "values": {0: "batch"}},
    )
    with open(os.path.join(out, "model.json"), "w") as f:
        json.dump({
            "fields": gamelab.FIELDS, "actionFields": gamelab.ACTION_FIELDS, "maxSeats": gamelab.MAX_SEATS,
            "noArg": gamelab.NO_ARG, "player": net.save_dict()["config"], "judge": critic.save_dict()["config"],
            "scale": {g["id"]: float(scale[g["number"]]) for g in gamelab.games()},
        }, f, indent=1)
    return verify(net, critic, out) if check else None


@torch.no_grad()
def verify(net, critic, out):
    """Largest difference between the ONNX files and the networks over batches of several shapes."""
    # ONNX Runtime reports usage to Microsoft unless told not to before it loads.
    os.environ.setdefault("ORT_DISABLE_TELEMETRY", "1")
    import onnxruntime as ort

    player = ort.InferenceSession(os.path.join(out, "player.onnx"), providers=["CPUExecutionProvider"])
    judge = ort.InferenceSession(os.path.join(out, "judge.onnx"), providers=["CPUExecutionProvider"])
    worst = 0.0
    for shape in ((1, 1, 1), (2, 40, 3), (5, 200, 270), (16, 9, 30)):
        tok, tc, act, ac = _sample(*shape)
        feed = {"tokens": tok.numpy(), "token_count": tc.numpy(), "actions": act.numpy(), "action_count": ac.numpy()}
        scores, values = player.run(None, feed)
        want_scores, want_values = _Player(net)(tok, tc, act, ac)
        real = torch.arange(shape[2])[None, :] < ac[:, None]
        worst = max(worst, float(np.abs(scores - want_scores.numpy())[real.numpy()].max()))
        worst = max(worst, float(np.abs(values - want_values.numpy()).max()))
        (values,) = judge.run(None, {"tokens": feed["tokens"], "token_count": feed["token_count"]})
        worst = max(worst, float(np.abs(values - _Judge(critic)(tok, tc).numpy()).max()))
    return worst


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("checkpoint")
    p.add_argument("out")
    a = p.parse_args()
    state = torch.load(a.checkpoint, map_location="cpu", weights_only=False)
    worst = export(Net.from_dict(state["net"]), Net.from_dict(state["critic"]), np.sqrt(state["square"]), a.out)
    print(f"written to {a.out}; largest difference from PyTorch {worst:.2e}")


if __name__ == "__main__":
    main()
