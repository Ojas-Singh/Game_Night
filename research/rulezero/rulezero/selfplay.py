"""Shared actor-only policy input and on-policy trajectory generation."""
from __future__ import annotations

from dataclasses import dataclass
import json
import math
import random
import time

from .game_definition import GameDefinition
from .gamespec_runtime import IRGame, RUNTIME_VERSION
from .artifacts import _git_commit


@dataclass
class GameTask:
    definition: GameDefinition

    @property
    def game_id(self):
        return 'gamespec:' + self.definition.spec_hash

    def load(self):
        return IRGame(self.definition.spec)


def render_policy_input(rules: str, state, player: int):
    legal = sorted(state.legal_actions(player))
    candidates = [{'candidateId': f'A{i}', 'environmentActionId': a,
                   'label': state.action_to_string(player, a)} for i, a in enumerate(legal)]
    prompt = f'RULES {rules}\nSTATE {state.information_state_string(player)}\nACTIONS ' + json.dumps(candidates, separators=(',', ':'))
    return prompt, candidates


def episode(task: GameTask, policy, seed: int, opponents=None, learner_seat=None):
    game = task.load()
    state = game.new_initial_state()
    rng = random.Random(seed)
    rows, transitions = [], []
    for step in range(512):
        if state.is_terminal():
            break
        if state.is_chance_node():
            outcomes = state.chance_outcomes()
            a = rng.choices([a for a, _ in outcomes], [p for _, p in outcomes])[0]
            transitions.append({'t': step, 'kind': 'chance', 'player': -1,
                                'chosenEnvironmentActionId': a})
            state.apply_action(a)
            continue
        player = state.current_player()
        prompt, candidates = render_policy_input(json.dumps(task.definition.spec, sort_keys=True, separators=(',', ':')), state, player)
        ids = [c['candidateId'] for c in candidates]
        student = learner_seat is None or learner_seat == player
        acting = policy if student else (opponents or {}).get(player)
        if acting is None:
            probabilities, value = [1 / len(ids)] * len(ids), 0.0
        else:
            probabilities, value = acting.distribution_value(prompt, ids)
        chosen = rng.choices(range(len(ids)), probabilities)[0]
        if student:
            rows.append({'prompt': prompt, 'candidates': ids, 'chosen': chosen,
                         'logProbability': math.log(max(1e-12, probabilities[chosen])),
                         'value': value, 'player': player})
        transitions.append({'t': step, 'kind': 'decision', 'player': player,
            'infoState': state.information_state_string(player), 'candidates': candidates,
            'legalEnvironmentActions': [c['environmentActionId'] for c in candidates],
            'chosenCandidateId': ids[chosen], 'chosenEnvironmentActionId': candidates[chosen]['environmentActionId'],
            'policy': probabilities, 'valueTarget': None, 'teacherPolicy': None})
        state.apply_action(candidates[chosen]['environmentActionId'])
    completed = state.is_terminal()
    returns = list(state.returns()) if completed else None
    if completed:
        for row in rows:
            row['return'] = returns[row['player']]
        for t in transitions:
            if t['kind'] == 'decision':
                t['valueTarget'] = returns[t['player']]
    else:
        rows = []
    return rows, {'schemaVersion': 2, 'game': {'id': task.game_id, 'specHash': task.definition.spec_hash, 'numPlayers': game.num_players()},
        'seedSchedule': [seed], 'completed': completed, 'returns': returns,
        'provenance': {'runtimeVersion': RUNTIME_VERSION, 'runner': 'rulezero.selfplay/v2'},
        'transitions': transitions}


def paired_evaluation(tasks, candidate, baseline, episodes=100, seed=40000):
    differences, wins, draws, per_game = [], 0, 0, {}
    for task in tasks:
        scores = []
        for i in range(episodes):
            # Each deal is played from every seat; paired seeds reduce chance noise.
            pair = []
            for seat in range(task.load().num_players()):
                opponents = {p: baseline for p in range(task.load().num_players())}
                _, ep = episode(task, candidate, seed + i, opponents, seat)
                if not ep['completed']:
                    raise ValueError('evaluation episode did not finish')
                value = ep['returns'][seat]
                pair.append(value)
                wins += int(value > 0)
                draws += int(value == 0)
            scores.append(sum(pair) / len(pair))
        differences.extend(scores)
        per_game[task.definition.family_id] = {'averageReturn': sum(scores) / len(scores)}
    import statistics
    mean = statistics.mean(differences)
    margin = 1.96 * statistics.stdev(differences) / math.sqrt(len(differences)) if len(differences) > 1 else float('inf')
    games = sum(task.load().num_players() * episodes for task in tasks)
    return {'averageReturn': mean, 'confidence95': [mean - margin, mean + margin],
            'winRate': wins / games, 'drawRate': draws / games, 'games': games,
            'byGame': per_game, 'illegalProposals': 0, 'fallbacks': 0,
            'nashConv': None, 'exploitability': None}
