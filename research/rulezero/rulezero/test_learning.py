import json
from pathlib import Path
import pytest

torch = pytest.importorskip('torch')
from rulezero.torch_backend import TorchBackend
from rulezero.backends import RenderedExample
from rulezero.selfplay import GameTask, episode, render_policy_input
from rulezero.game_definition import GameDefinition
from rulezero.test_ir_games import KUHNISH


def test_weights_change_and_reload_matches(tmp_path):
    backend = TorchBackend(seed=7)
    prompt = 'RULES choose win\nSTATE turn\nACTIONS [{"candidateId":"A0","label":"lose"},{"candidateId":"A1","label":"win"}]'
    ex = RenderedExample('state', prompt, ('A0', 'A1'), 'A1', (0, 1), (0., 1.))
    before = backend.probs(prompt, ex.candidates)
    for _ in range(6):
        backend.train_step([ex])
    after = backend.probs(prompt, ex.candidates)
    assert after[1] > before[1]
    backend.save(tmp_path / 'checkpoint.pt')
    loaded = TorchBackend(seed=88)
    loaded.load(tmp_path / 'checkpoint.pt')
    assert loaded.probs(prompt, ex.candidates) == pytest.approx(after, abs=1e-7)
    assert [loaded.sample(prompt, ex.candidates) for _ in range(10)] == [backend.sample(prompt, ex.candidates) for _ in range(10)]


def test_selfplay_without_teacher_updates_policy():
    backend = TorchBackend(seed=1)
    task = GameTask(GameDefinition('kuhn', KUHNISH, 'rules', split='train'))
    rows = []
    for seed in range(4):
        batch, trajectory = episode(task, backend, seed)
        assert trajectory['completed']
        assert trajectory['returns'] is not None
        rows.extend(batch)
    before = {k: v.clone() for k, v in backend.network.state_dict().items()}
    metrics = backend.ppo_step(rows, epochs=1)
    assert metrics['updates'] > 0
    assert any(not torch.equal(v, before[k]) for k, v in backend.network.state_dict().items())
    for row in rows:
        assert row['candidates'][row['chosen']].startswith('A')
        assert 'deck=hidden' in row['prompt']
