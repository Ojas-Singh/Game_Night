from copy import deepcopy
import json

import pytest

from rulezero.gamespec_runtime import IRGame
from rulezero.service import Session, handle
from rulezero.test_ir_games import KUHNISH, CLAIM


def session():
    s = Session(deepcopy(KUHNISH), 17)
    s._resolve_chance()
    return s


def test_wrong_seat_and_rejected_actions_are_atomic():
    s = session()
    before = json.dumps(s.snapshot(), sort_keys=True)
    for msg in ({'player': 1, 'action': 0}, {'player': 0, 'action': 999},
                {'player': 0, 'action': 0, 'expectedRevision': 3}, {'action': 0}):
        _, result = handle(s, {'op': 'apply', **msg})
        assert not result['ok']
        assert json.dumps(s.snapshot(), sort_keys=True) == before
    with pytest.raises(ValueError):
        s.state.apply_action(999)
    assert json.dumps(s.snapshot(), sort_keys=True) == before


def test_commands_deduplicate_and_conflicting_reuse_fails():
    s = session()
    command = dict(player=0, action=0, expectedRevision=0, commandId='one')
    result = s.apply(command)
    before = json.dumps(s.snapshot(), sort_keys=True)
    assert s.apply(command) == result
    assert json.dumps(s.snapshot(), sort_keys=True) == before
    with pytest.raises(ValueError):
        s.apply({**command, 'action': 1})


def test_completed_trajectory_keeps_chance_and_decision_transitions():
    s = session()
    command_id = 0
    while not s.state.is_terminal():
        if s.state.is_chance_node():
            s._resolve_chance()
            continue
        player = s.state.current_player()
        action = s.state.legal_actions(player)[0]
        s.apply({'player': player, 'action': action,
                 'expectedRevision': s.revision, 'commandId': str(command_id)})
        command_id += 1
    assert any(t['kind'] == 'chance' for t in s.trajectory)
    assert any(t['kind'] == 'decision' for t in s.trajectory)


def test_duplicate_ranks_have_weighted_probability():
    st = IRGame(deepcopy(KUHNISH)).new_initial_state()
    st.zones['deck'] = [9, 9, 10]
    assert st.chance_outcomes() == [(9, 2 / 3), (10, 1 / 3)]


def test_nonactor_and_spectator_have_no_candidates():
    s = session()
    assert s.view(0)['candidates']
    assert s.view(1)['candidates'] == []
    assert s.view(-1)['candidates'] == []
    assert all('cards' not in z for z in s.view(-1)['zones'] if z['visibility'] != 'public')


def test_restore_preserves_rng_recall_and_deduplication():
    s = session()
    s.apply(dict(player=0, action=0, expectedRevision=0, commandId='one'))
    snap = json.loads(json.dumps(s.snapshot()))
    restored = session()
    restored.restore(snap)
    assert restored.view(0) == s.view(0)
    assert restored._rng.random() == s._rng.random()
    assert restored.commands == s.commands


def test_recall_retains_card_after_it_leaves_owner_zone():
    s = session()
    original = s.state.information_state_string(0)
    s.state.zones['hand0'].clear()
    s.state._remember()
    assert s.state._recall[1][1] in s.state.information_state_string(0)
    assert original != s.state.information_state_string(0)
    assert 'hand0=hidden' in s.state.information_state_string(1)


def test_reaction_starts_after_initiator_and_excludes_them():
    spec = deepcopy(CLAIM)
    spec['players']['count'] = 3
    spec['vars'].append({'id': 'score2', 'init': 0})
    st = IRGame(spec).new_initial_state()
    reaction = next(i for i, ph in enumerate(spec['phases']) if ph['kind'] == 'reaction')
    st.last_actor = 1
    st._enter_phase(reaction)
    assert st.window['queue'] == (2, 0)
