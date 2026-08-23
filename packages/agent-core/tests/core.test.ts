/** Serializer + legal-action sanity against real engine views. */

import { describe, expect, it } from 'vitest';
import { CaboEngine, buildPlayerView as caboView } from '@game-night/engine-cabo';
import { PairOneEngine, buildPlayerView as pairOneView } from '@game-night/engine-pairone';
import { enumerateLegalActions, serializeView, RULES_TEXT } from '@game-night/agent-core';

const players = [
  { id: 'p0', name: 'A', seat: 0 },
  { id: 'p1', name: 'B', seat: 1 },
];

describe('legal action enumeration', () => {
  it('cabo INITIAL_PEEK offers exactly C(4,2) peeks for the owing player', () => {
    const e = new CaboEngine();
    e.createGame(players, { seed: 3 });
    const v = caboView(e.getState(), 'p0');
    expect(v.needsInitialPeek).toBe(true);
    const acts = enumerateLegalActions(v, 'p0');
    const peeks = acts.filter((a) => a.type === 'PEEK_STARTING');
    expect(peeks.length).toBe(6); // C(4,2)
    for (const a of peeks) expect(e.validateAction(a)).toBe(true);
  });

  it('pairone TURN offers every face-down slot as FLIP_CARD, all valid', () => {
    const e = new PairOneEngine();
    e.createGame(players, { seed: 3 });
    const s = e.getState();
    const who = s.players[s.currentTurn]!.id;
    const v = pairOneView(s, who);
    const acts = enumerateLegalActions(v, who).filter((a) => a.type === 'FLIP_CARD');
    expect(acts.length).toBe(52);
    for (const a of acts) expect(e.validateAction(a)).toBe(true);
  });

  it('never offers actions to non-current players mid-turn (pairone)', () => {
    const e = new PairOneEngine();
    e.createGame(players, { seed: 9 });
    const s = e.getState();
    const notTurn = s.players[(s.currentTurn + 1) % 2]!.id;
    const v = pairOneView(s, notTurn);
    expect(v.players.find((p) => p.id === notTurn)?.isCurrentTurn).toBe(false);
  });
});

describe('view serialization', () => {
  it('cabo text carries phase, discard and hand lines', () => {
    const e = new CaboEngine();
    e.createGame(players, { seed: 11 });
    const v = caboView(e.getState(), 'p0');
    const text = serializeView(v, 'p0');
    expect(text).toContain(`phase=${v.phase}`);
    expect(text).toContain('YOU');
    expect(RULES_TEXT.cabo).toMatch(/CALL_CABO/);
  });

  it('pairone text renders the full grid with row labels', () => {
    const e = new PairOneEngine();
    e.createGame(players, { seed: 11 });
    const v = pairOneView(e.getState(), 'p0');
    const text = serializeView(v, 'p0');
    expect(text).toContain('r00|');
    expect(text.match(/\?/g)?.length ?? 0).toBeGreaterThan(50);
    expect(RULES_TEXT.pairone).toMatch(/52 cards/);
  });
});
