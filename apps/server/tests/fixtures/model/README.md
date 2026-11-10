A tiny player with random weights, for the server tests only (it plays legal
moves, not good ones). Written with the trainer's exporter:

    cd train && python - <<'PY'
    import numpy as np, torch
    from gamelab_train.model import Net, NetConfig
    from gamelab_train.export import export
    torch.manual_seed(7)
    net = Net(NetConfig(width=16, layers=1, heads=2))
    critic = Net(NetConfig(width=16, layers=1, heads=2, policy=False))
    for m in (net.score[-1], net.value[-1], critic.value[-1]):
        torch.nn.init.normal_(m.weight, std=0.5)
    export(net, critic, np.full(16, 10.0), "../apps/server/tests/fixtures/model")
    PY

Write it again whenever the token layout of the rules core changes.
