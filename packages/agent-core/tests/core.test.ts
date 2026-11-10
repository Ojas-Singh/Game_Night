/** Serializer + legal-action sanity against real engine views. */

import { describe, expect, it } from 'vitest';
import type { Card } from '@game-night/shared';
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

  it('keeps flush interrupts available while another player owes a transfer', () => {
    // Two cards each, dealt round-robin: p0=[9,9] p1=[5,5] p2=[4,4]; a 4 is drawn first.
    const card = (id: string, suit: Card['suit'], rank: Card['rank']): Card => ({ id, suit, rank });
    const order = [
      card('a1', 'spades', 9), card('b1', 'spades', 5), card('d1', 'diamonds', 4),
      card('a2', 'hearts', 9), card('b2', 'hearts', 5), card('d2', 'hearts', 4),
      card('draw4', 'clubs', 4),
      ...Array.from({ length: 15 }, (_, i) => card(`f${i}`, i % 2 ? 'hearts' : 'spades', (2 + (i % 2)) as Card['rank'])),
    ];
    const e = new CaboEngine();
    e.createGame([
      { id: 'p0', name: 'A', seat: 0 },
      { id: 'p1', name: 'B', seat: 1 },
      { id: 'p2', name: 'C', seat: 2 },
    ], { forcedDeck: order.reverse(), firstTurnSeat: 0, rules: { startingCards: 2 } });
    for (const p of e.getState().players) {
      e.handleAction({ type: 'PEEK_STARTING', playerId: p.id, cardIndexes: [0, 1] });
    }
    expect(e.handleAction({ type: 'DRAW', playerId: 'p0' }).ok).toBe(true);
    expect(e.handleAction({ type: 'DISCARD_DRAWN', playerId: 'p0' }).ok).toBe(true);
    expect(e.handleAction({
      type: 'FLUSH_OTHER',
      playerId: 'p0',
      targetPlayerId: 'p2',
      cardId: 'd1',
    }).ok).toBe(true);
    expect(e.getState().phase).toBe('TRANSFER_PENDING');

    // Simulate p1 remembering a matching card in p2's remaining hand.
    const secondTargetCard = e.getState().hands.p2!.find((held) => !!held)!;
    e.getState().knowledge.p1!.push(secondTargetCard.id);
    const waiting = e.getPlayerState('p1');
    expect(enumerateLegalActions(waiting, 'p1')).toContainEqual({
      type: 'FLUSH_OTHER',
      playerId: 'p1',
      targetPlayerId: 'p2',
      cardId: secondTargetCard.id,
    });
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
