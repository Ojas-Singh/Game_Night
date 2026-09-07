"""Bounded CPU self-play → PPO → paired validation → checkpoint promotion."""
from __future__ import annotations

import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import time
import uuid

from .artifacts import ArtifactStore
from .backends import RenderedExample
from .game_definition import GameDefinition
from .selfplay import GameTask, episode, paired_evaluation, render_policy_input
from .checkpoint_registry import registry_root, register_checkpoint, load_checkpoint


def default_tasks():
    from .gallery import GALLERY
    return [GameTask(GameDefinition(gid, GALLERY[gid].spec(), GALLERY[gid].blurb,
                                    split='train')) for gid in ('kuhnish', 'claim', 'goofseq')]


def distill(backend, tasks, episodes=20, seed=0):
    from .solver_agents import CFRAgent, choose_agent_for_game
    examples = []
    for task in tasks:
        if choose_agent_for_game(task.definition.spec) != 'cfr':
            continue
        teacher = CFRAgent(task.definition.spec, iterations=100, seed=seed)
        for i in range(episodes):
            _, trajectory = episode(task, backend, seed + i)
            for t in trajectory['transitions']:
                if t['kind'] != 'decision':
                    continue
                candidates = t['candidates']
                legal, probs = teacher.probs_for(t['infoState'])
                lookup = dict(zip(legal, probs))
                target = [lookup.get(c['environmentActionId'], 0.0) for c in candidates]
                if not sum(target):
                    continue
                prompt = f'RULES {json.dumps(task.definition.spec, sort_keys=True, separators=(chr(44), chr(58)))}\nSTATE {t["infoState"]}\nACTIONS ' + json.dumps(candidates, separators=(',', ':'))
                ids = tuple(c['candidateId'] for c in candidates)
                examples.append(RenderedExample(t['infoState'], prompt, ids, ids[target.index(max(target))],
                    tuple(c['environmentActionId'] for c in candidates), tuple(target)))
    for offset in range(0, len(examples), 16):
        backend.train_step(examples[offset:offset + 16])
    return len(examples)


def run_training(config: dict, *, progress=None, cancelled=None):
    from .torch_backend import TorchBackend
    tasks = [GameTask(GameDefinition(**d)) for d in config['definitions']] if config.get('definitions') else default_tasks()
    if any(t.definition.split != 'train' for t in tasks):
        raise ValueError('Training accepts only definitions in the curated train split')
    seed = int(config.get('seed', 0))
    generations = min(100, max(1, int(config.get('generations', 5))))
    episodes = min(1000, max(2, int(config.get('episodes', 24))))
    eval_episodes = min(1000, max(2, int(config.get('evalEpisodes', 40))))
    run_id = config.get('runId') or uuid.uuid4().hex
    if len(run_id) != 32 or any(c not in '0123456789abcdef' for c in run_id):
        raise ValueError('invalid run id')
    root = registry_root()
    store = ArtifactStore(root)
    manifest_path = root / f'run-{run_id}.json'
    backend = TorchBackend(seed)
    start_generation = 1
    records = []
    if config.get('resume'):
        previous = json.loads(manifest_path.read_text())
        if previous['config'] != {k: v for k, v in config.items() if k not in ('resume', 'runId')}:
            raise ValueError('resume configuration must match the saved run')
        records = previous['checkpoints']
        backend = load_checkpoint(records[-1]['id'])
        start_generation = records[-1]['generation'] + 1
    else:
        records.append(register_checkpoint(backend, run_id=run_id, generation=0, metrics={}, promoted=False))
    initial = load_checkpoint(records[0]['id'])
    champion = load_checkpoint(next((r['id'] for r in reversed(records) if r['promoted']), records[0]['id']))
    manifest = {'runId': run_id, 'status': 'running', 'config': {k: v for k, v in config.items() if k not in ('resume', 'runId')},
                'checkpoints': records, 'families': [t.definition.family_id for t in tasks],
                'splitPolicy': {'trainingSeeds': 'seed + generation*10000 + episode', 'validationSeeds': [400000, 500000], 'testSeeds': [900000, 1000000]}}
    def publish():
        tmp = manifest_path.with_suffix('.tmp')
        tmp.write_text(json.dumps(manifest, allow_nan=False))
        os.replace(tmp, manifest_path)
        if progress:
            progress(manifest)
    publish()
    if start_generation == 1 and config.get('teacher'):
        manifest['teacherExamples'] = distill(backend, tasks, seed=seed)
    for generation in range(start_generation, generations + 1):
        if cancelled and cancelled():
            manifest['status'] = 'cancelled'
            publish()
            return manifest
        began = time.monotonic()
        rows, trajectories = [], []
        prior = load_checkpoint(records[-1]['id'])
        for i in range(episodes):
            task = tasks[i % len(tasks)]
            n = task.load().num_players()
            opponent = [None, prior, champion][i % 3]
            learned_seat = i % n
            batch, trajectory = episode(task, backend, seed + generation * 10000 + i,
                {p: opponent for p in range(n)}, learned_seat)
            trajectory['provenance']['checkpointId'] = records[-1]['id']
            rows.extend(batch); trajectories.append(trajectory)
        artifact_id = store.put_json(trajectories, kind='trajectories', parents=[records[-1]['id']])
        training = backend.ppo_step(rows)
        evaluation = paired_evaluation(tasks, backend, champion, eval_episodes, seed=400000)
        promoted = evaluation['confidence95'][0] > 0
        metrics = {'training': training, 'validation': evaluation,
                   'unfinished': sum(not t['completed'] for t in trajectories),
                   'episodesPerSecond': episodes / max(.001, time.monotonic() - began),
                   'trajectoryArtifact': artifact_id}
        record = register_checkpoint(backend, run_id=run_id, generation=generation,
            metrics=metrics, parent=records[-1]['id'], promoted=promoted)
        records.append(record)
        if promoted:
            champion = load_checkpoint(record['id'])
        publish()
    manifest['status'] = 'done'
    # Test is evaluated once, after all promotion decisions, and never fed back.
    manifest['testVsInitial'] = paired_evaluation(tasks, champion, initial, eval_episodes, seed=900000)
    manifest['generalization'] = 'Not measured: these are within-family held-out episodes.'
    publish()
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    print(json.dumps(run_training(json.loads(Path(args.config).read_text())), indent=2))
