import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { deal, preset } from '@game-night/core';
import { ModelPlayer } from '../src/agents/model.js';

/** A tiny network with random weights (see tests/fixtures/model/README.md). */
const FIXTURE = fileURLToPath(new URL('./fixtures/model', import.meta.url));

describe('model player', () => {
  it('plays whole rounds of every site game with legal moves', async () => {
    const model = await ModelPlayer.load(FIXTURE, { samples: 2 });
    for (const [game, players] of [['cabo', 3], ['seep', 4], ['pairone', 2]] as const) {
      expect(model.plays(game)).toBe(true);
      const table = deal(game, preset(game), players, 11);
      let steps = 0;
      for (; table.toAct >= 0 && steps < 400; steps += 1) {
        const seat = table.toAct;
        const round = table.forSeat(seat, false, steps) ?? table;
        const choice = await model.choose(round, steps);
        const legal = JSON.parse(round.legal()) as unknown[];
        expect(choice.policy).toHaveLength(legal.length);
        expect(choice.policy.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
        expect(choice.index).toBeLessThan(legal.length);
        const { action, more } = JSON.parse(round.atTable(choice.index)) as { action: unknown; more: boolean };
        if (more) continue; // a table action made of several model moves; ask again
        if (action === null) break;
        expect(table.apply(seat, JSON.stringify(action)) ?? null).toBeNull();
      }
      expect(steps).toBeGreaterThan(5);
    }
  }, 120_000);

  it('looks ahead: the values shift the choice', async () => {
    const bare = await ModelPlayer.load(FIXTURE, { samples: 0 });
    const searching = await ModelPlayer.load(FIXTURE, { samples: 4, temperature: 0.05 });
    const round = deal('seep', preset('seep'), 4, 3);
    let sim = round.forSeat(round.toAct, false, 1)!;
    while ((JSON.parse(sim.legal()) as unknown[]).length < 3) {
      round.step(0);
      sim = round.forSeat(round.toAct, false, 1)!;
    }
    const a = await bare.choose(sim, 1);
    const b = await searching.choose(sim, 1);
    expect(a.values).toHaveLength(0);
    expect(b.values).toHaveLength(a.prior.length);
    expect(a.policy.every((p, i) => Math.abs(p - a.prior[i]!) < 1e-5)).toBe(true);
    expect(b.policy.some((p, i) => Math.abs(p - b.prior[i]!) > 1e-3)).toBe(true);
  }, 60_000);
});
