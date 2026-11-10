import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { preset } from '@game-night/core';
import type { LabRunStatus } from '@game-night/shared';
import { ModelPlayer } from '../src/agents/model.js';
import { measure } from '../src/lab/measure.js';
import { LabRefusal, LabRuns } from '../src/lab/runs.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/model', import.meta.url));

async function finished(runs: LabRuns, id: string): Promise<LabRunStatus> {
  for (;;) {
    const status = runs.status(id)!;
    if (status.state !== 'running') return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('lab measurements', () => {
  it('reports on rounds of every game with random moves', async () => {
    for (const [game, players] of [['cabo', 3], ['pairone', 2], ['seep', 4], ['minipoker', 2]] as const) {
      const report = await measure({ game, rules: preset(game), players, rounds: 40, player: 'random', seed: 1 });
      expect(report.rounds + Math.round(report.abandoned * 40)).toBeGreaterThanOrEqual(39);
      expect(report.seats).toHaveLength(players);
      const won = report.seats.reduce((sum, s) => sum + s.won.mean! + s.shared.mean!, 0) + report.draws.mean!;
      expect(won).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(report.length.mean).toBeGreaterThan(1);
      expect(report.actions.some((a) => a.perRound > 0)).toBe(true);
      for (const a of report.actions) if (a.taken !== null) expect(a.taken).toBeLessThanOrEqual(1);
      expect(report.stats.length).toBeGreaterThan(0);
    }
  });

  it('repeats exactly for a seed', async () => {
    const options = { game: 'cabo', rules: preset('cabo'), players: 2, rounds: 30, player: 'random', seed: 7 } as const;
    expect(await measure(options)).toEqual(await measure(options));
  });

  it('measures the trained player, with and without looking ahead', async () => {
    const model = await ModelPlayer.load(FIXTURE, { samples: 2 });
    for (const player of ['model', 'search'] as const) {
      const report = await measure({ game: 'cabo', rules: preset('cabo'), players: 2, rounds: 6, player, seed: 3, model });
      expect(report.rounds).toBeGreaterThan(0);
      expect(report.playedBy).toBe(player);
    }
  }, 120_000);
});

describe('lab runs', () => {
  it('compares rule sets and says what moved', async () => {
    const runs = new LabRuns();
    const id = runs.start({
      game: 'cabo',
      players: 2,
      rounds: 300,
      player: 'random',
      seed: 0,
      variants: [
        { name: 'Standard', rules: {} },
        { name: 'Six cards', rules: { startingCards: 6 } },
      ],
    });
    expect(() => runs.start({ game: 'cabo', players: 2, rounds: 10, player: 'random', seed: 0, variants: [{ name: 'a', rules: {} }] }))
      .toThrow(/busy/);
    const status = await finished(runs, id);
    expect(status.state).toBe('done');
    expect(status.done).toBe(600);
    const result = status.result!;
    expect(result.baseline).toBe('Standard');
    expect(result.reports['Six cards']!.rules.startingCards).toBe(6);
    const mean = result.changes['Six cards']!.find((c) => c.name === 'Mean hand total')!;
    expect(mean.change).toBeGreaterThan(0);
    expect(Math.abs(mean.z!)).toBeGreaterThan(3);
  });

  it('refuses what it cannot run', () => {
    const runs = new LabRuns();
    const base = { game: 'cabo', players: 2, rounds: 100, player: 'random', seed: 0, variants: [{ name: 'a', rules: {} }] } as const;
    expect(() => runs.start({ ...base, game: 'chess' })).toThrow(LabRefusal);
    expect(() => runs.start({ ...base, players: 9 })).toThrow(/players/);
    expect(() => runs.start({ ...base, rounds: 10_000_000 })).toThrow(/rounds/);
    expect(() => runs.start({ ...base, player: 'model' })).toThrow(/trained player/);
    expect(() => runs.start({ ...base, variants: [{ name: 'a', rules: { startingCards: 99 } }] })).toThrow(/startingCards/);
    expect(() => runs.start({ ...base, variants: [{ name: 'a', rules: {} }, { name: 'a', rules: {} }] })).toThrow(/name/);
  });

  it('stops a run that is cancelled', async () => {
    const runs = new LabRuns();
    const id = runs.start({ game: 'seep', players: 4, rounds: 20_000, player: 'random', seed: 0, variants: [{ name: 'a', rules: {} }] });
    runs.cancel(id);
    expect((await finished(runs, id)).state).toBe('cancelled');
  });
});
