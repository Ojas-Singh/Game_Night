/**
 * Phase-1 arena guarantees: full episodes complete legally, seeds reproduce
 * exactly, and search actually outplays random.
 */

import { describe, expect, it } from 'vitest';
import type { GameId } from '@game-night/agent-core';
import { RandomBot, CaboHeuristicBot, PairOneHeuristicBot, MonteCarloBot } from '@game-night/agent-bots';
import { runEpisode } from '../src/runner.js';
import { EloLadder } from '../src/elo.js';
import type { EngineWorld } from '../src/world.js';

const seatsFor = (game: GameId) =>
  game === 'cabo'
    ? [new CaboHeuristicBot(), new CaboHeuristicBot({ idSuffix: '-2' }), new RandomBot()]
    : [new PairOneHeuristicBot(), new PairOneHeuristicBot('-2'), new RandomBot()];

describe('episode legality & completion', () => {
  for (const game of ['cabo', 'pairone'] as const) {
    it(`${game}: heuristics+random finish without illegal actions`, async () => {
      const outcome = await runEpisode({
        gameId: game,
        seed: 42,
        agents: seatsFor(game),
      });
      expect(outcome.aborted).toBe(false);
      expect(outcome.steps).toBeGreaterThan(0);
      expect(Object.keys(outcome.scores).length).toBe(3);
      expect(outcome.winnerIds.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('same seed → identical scores (determinism)', async () => {
    const run = () =>
      runEpisode({ gameId: 'pairone', seed: 7, agents: seatsFor('pairone') });
    const a = await run();
    const b = await run();
    expect(a.scores).toEqual(b.scores);
    expect(a.steps).toBe(b.steps);
  });
});

describe('monte-carlo search', () => {
  it('pair one: MC beats random over a small match', async () => {
    let mcWins = 0;
    const N = 6;
    for (let i = 0; i < N; i++) {
      let world: EngineWorld | null = null;
      const mc = new MonteCarloBot(
        () => {
          if (!world) throw new Error('world unbound');
          return world;
        },
        { totalSims: 48 },
      );
      const outcome = await runEpisode({
        gameId: 'pairone',
        seed: 100 + i,
        agents: [mc, new RandomBot()],
        bindWorld: (w) => {
          world = w;
        },
      });
      const mcId = outcome.record?.players[0]?.id ?? 'p0';
      if (outcome.winnerIds.includes(mcId)) mcWins++;
    }
    expect(mcWins).toBeGreaterThan(N / 2);
  }, 120_000);

  it('cabo: MC episode completes legally', async () => {
    let world: EngineWorld | null = null;
    const mc = new MonteCarloBot(
      () => {
        if (!world) throw new Error('world unbound');
        return world;
      },
      { totalSims: 24, maxCandidates: 8 },
    );
    const outcome = await runEpisode({
      gameId: 'cabo',
      seed: 5,
      agents: [mc, new CaboHeuristicBot()],
      bindWorld: (w) => {
        world = w;
      },
    });
    expect(outcome.aborted).toBe(false);
  }, 120_000);
});

describe('elo ladder', () => {
  it('winner gains rating vs loser', () => {
    const ladder = new EloLadder();
    ladder.recordGame(['a', 'b'], (id) => (id === 'a' ? 1 : 0));
    expect(ladder.rating('a')).toBeGreaterThan(1000);
    expect(ladder.rating('b')).toBeLessThan(1000);
  });

  it('ties move nobody much', () => {
    const ladder = new EloLadder();
    ladder.recordGame(['a', 'b'], () => 0.5);
    expect(Math.abs(ladder.rating('a') - 1000)).toBeLessThan(1);
  });
});
