import { describe, expect, it } from 'vitest';
import { deal, games, load, preset } from '../src/index.js';

describe('the rules core', () => {
  it('knows the site games', () => {
    expect(games().map((g) => g.id)).toEqual(expect.arrayContaining(['cabo', 'pairone', 'seep']));
  });

  it('deals every game from its default rules, the same for the same seed', () => {
    for (const g of games()) {
      const players = Math.max(g.minPlayers, Math.min(4, g.maxPlayers));
      const a = deal(g.id, preset(g.id), players, 7).save();
      expect(deal(g.id, preset(g.id), players, 7).save()).toBe(a);
      expect(deal(g.id, preset(g.id), players, 8).save()).not.toBe(a);
      expect(load(g.id, a).save()).toBe(a);
    }
  });
});
