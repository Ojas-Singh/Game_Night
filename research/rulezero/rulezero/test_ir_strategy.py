import pytest
from copy import deepcopy
from rulezero.gamespec_runtime import IRGame
from rulezero.gamespec_ir import IRValidationError, validate_ir
from rulezero.service import Session
from rulezero.strategy_fixtures import grid_game, resource_game, commitment_game
from rulezero.selfplay import GameTask, episode
from rulezero.game_definition import GameDefinition


def test_grid_uses_parameterized_actions_and_detects_a_win():
    st = IRGame(grid_game()).new_initial_state()
    for cell in [0,3,1,4,2]:
        label = f'place[cell={cell}]'
        st.apply_action(st._action_table().index(label))
    assert st.is_terminal()
    assert st.returns() == [1,-1]
    assert st.get_game().num_distinct_actions() >= 9


def test_finite_chance_and_cooperative_returns_are_preserved():
    st = IRGame(resource_game()).new_initial_state()
    assert st.chance_outcomes() == [(0,.25),(1,.75)]
    st.apply_action(1)
    st.apply_action(0)
    assert st.returns() == [3,3]


def test_commitment_is_hidden_from_second_player_and_spectator():
    a, b = Session(commitment_game()), Session(commitment_game())
    a.apply({'player':0,'action':0})
    b.apply({'player':0,'action':1})
    for viewer in (-1,1):
        assert a.view(viewer) == b.view(viewer)
    assert a.view(0)['informationState'] != b.view(0)['informationState']


def test_public_state_cannot_copy_private_expression():
    spec = deepcopy(commitment_game())
    for var in spec['vars']:
        if var['id'] == 'score0':
            var.pop('visibility', None)
    with pytest.raises(IRValidationError, match='private expression'):
        validate_ir(spec)


@pytest.mark.parametrize('factory', [grid_game, resource_game, commitment_game])
def test_generic_trajectory_path(factory):
    spec = factory()
    task = GameTask(GameDefinition(spec['name'],spec,'rules',split='test'))
    for seed in range(5):
        _, result = episode(task, None, seed)
        assert result['completed']
        assert all(task.load().min_utility() <= v <= task.load().max_utility() for v in result['returns'])
