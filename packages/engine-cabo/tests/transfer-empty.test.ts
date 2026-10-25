import { describe, expect, it } from 'vitest';
import { S, H, D, CL, c, setup, mustOk } from './helpers.js';

/**
 * A player who has already flushed every card can still flush another
 * player's matching card. The rules then ask them to give one of their cards
 * to that player — but they have none. That used to leave the table stuck in
 * TRANSFER_PENDING with nobody able to act.
 */
describe('transfer owed by an empty hand', () => {
  it('is skipped instead of dead-locking the table', () => {
    // Two cards each, pop order round-robin: p1=[a1,a2] p2=[b1,b2] p3=[d1,d2]
    const order = [
      c('a1', S, 9), c('b1', S, 4), c('d1', D, 4),
      c('a2', H, 9), c('b2', H, 4), c('d2', D, 7),
      c('draw4', CL, 4),
      ...Array.from({ length: 30 }, (_, i) => c(`f${i}`, i % 2 ? H : S, 2 + (i % 3))),
    ];
    const e = setup(order, { rules: { startingCards: 2 } });
    for (const id of ['p1', 'p2', 'p3']) mustOk(e, { type: 'PEEK_STARTING', playerId: id, cardIndexes: [0, 1] });
    mustOk(e, { type: 'DRAW', playerId: 'p1' });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: 'p1' }); // 4♣ on top
    mustOk(e, { type: 'FLUSH_OWN', playerId: 'p2', cardIds: ['b1', 'b2'] }); // p2 now empty
    mustOk(e, { type: 'FLUSH_OTHER', playerId: 'p2', targetPlayerId: 'p3', cardId: 'd1' }); // correct guess
    const s = e.getState();
    expect(s.phase).not.toBe('TRANSFER_PENDING');
    expect(s.pendingTransfers).toHaveLength(0);
    expect(s.hands.p3!.filter(Boolean).map((x) => x!.id)).toEqual(['d2']);
    // The turn carries on normally.
    mustOk(e, { type: 'END_TURN', playerId: 'p1' });
  });
});

describe('transfer owed, then the debtor flushes their last card', () => {
  it('drops the impossible transfer and restores the phase', () => {
    // p2 holds [4, 4]; p3 holds a 4. p2 flushes p3's 4 first (owes a card),
    // then flushes both own 4s before paying.
    const order = [
      c('a1', S, 9), c('b1', S, 4), c('d1', D, 4),
      c('a2', H, 9), c('b2', H, 4), c('d2', D, 7),
      c('draw4', CL, 4),
      ...Array.from({ length: 30 }, (_, i) => c(`f${i}`, i % 2 ? H : S, 2 + (i % 3))),
    ];
    const e = setup(order, { rules: { startingCards: 2 } });
    for (const id of ['p1', 'p2', 'p3']) mustOk(e, { type: 'PEEK_STARTING', playerId: id, cardIndexes: [0, 1] });
    mustOk(e, { type: 'DRAW', playerId: 'p1' });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: 'p1' });
    mustOk(e, { type: 'FLUSH_OTHER', playerId: 'p2', targetPlayerId: 'p3', cardId: 'd1' });
    expect(e.getState().phase).toBe('TRANSFER_PENDING');
    mustOk(e, { type: 'FLUSH_OWN', playerId: 'p2', cardIds: ['b1', 'b2'] });
    const s = e.getState();
    expect(s.pendingTransfers).toHaveLength(0);
    expect(s.phase).toBe('TURN_END');
    mustOk(e, { type: 'END_TURN', playerId: 'p1' });
  });
});
