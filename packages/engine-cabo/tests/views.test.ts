import { describe, expect, it } from 'vitest';
import { CaboEngine } from '../src/index.js';
import { S, H, CL, D, c, setup, peekAll, mustFail, mustOk } from './helpers.js';

/** p1: 4,9,2,7 · p2: K♠,3,5,Q · p3: 6,2,8,J — deliberate spread. */
function order(): ReturnType<typeof c>[] {
  return [
    c('a1', S, 4), c('b1', CL, 13), c('d1', H, 6),
    c('a2', H, 9), c('b2', D, 3), c('d2', S, 2),
    c('a3', CL, 2), c('b3', H, 5), c('d3', D, 8),
    c('a4', D, 7), c('b4', S, 12), c('d4', CL, 11),
    c('draw0', H, 3),
    ...Array.from({ length: 20 }, (_, i) => c(`x${i}`, S, 2 + (i % 3))),
  ];
}

describe('hidden-information filtering', () => {
  it('never sends other players\u2019 hidden card values', () => {
    const e = setup(order(), { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    const v1 = e.getPlayerState('p1');
    // p1 knows exactly their two peeked cards (indexes 0,1).
    expect(Object.keys(v1.knownCards).sort()).toEqual(['a1', 'a2']);
    // Opponent hands appear as opaque ids only.
    expect(v1.handCardIds.p2).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(v1.knownCards.b1).toBeUndefined();
    expect(v1.knownCards.d4).toBeUndefined();
    // No hidden card VALUE objects leak into the serialized view: the only
    // value objects present are the viewer's own known cards.
    const valueIds = Object.values(JSON.parse(JSON.stringify(v1)).knownCards).map(
      (card) => (card as { id: string }).id,
    );
    expect(valueIds.sort()).toEqual(['a1', 'a2']);
    const v2 = e.getPlayerState('p2');
    expect(Object.keys(v2.knownCards).sort()).toEqual(['b1', 'b2']);
  });

  it('initial peeks grant knowledge only of the peeked cards', () => {
    const e = setup(order());
    // Only p1 and p2 peek indexes [0,1]; p3 peeks [2,3].
    mustOk(e, { type: 'PEEK_STARTING', playerId: 'p1', cardIndexes: [0, 1] });
    mustOk(e, { type: 'PEEK_STARTING', playerId: 'p2', cardIndexes: [0, 1] });
    mustOk(e, { type: 'PEEK_STARTING', playerId: 'p3', cardIndexes: [2, 3] });
    expect(Object.keys(e.getPlayerState('p3').knownCards).sort()).toEqual(['d3', 'd4']);
  });

  it('drawn card value is visible only to the drawing player', () => {
    const e = setup(order(), { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: 'p1' });
    const v1 = e.getPlayerState('p1');
    const v2 = e.getPlayerState('p2');
    expect(v1.drawnCard).toMatchObject({ id: 'draw0', rank: 3 });
    expect(v2.drawnCard).toBeNull();
    expect(v2.knownCards.draw0).toBeUndefined();
  });

  it('removes a flushed card from the viewer hand view while preserving its slot', () => {
    const forced = order();
    forced[12] = c('draw4', H, 4);
    const e = setup(forced, { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: 'p1' });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: 'p1' });

    // Another player flushes p1's matching card. The local viewer must
    // receive the hole, not the card id that has moved to the discard pile.
    mustOk(e, { type: 'FLUSH_OTHER', playerId: 'p2', targetPlayerId: 'p1', cardId: 'a1' });
    const v1 = e.getPlayerState('p1');
    expect(v1.handCardIds.p1).toEqual(['__slot__0', 'a2', 'a3', 'a4']);
    expect(v1.handCardIds.p1).not.toContain('a1');
  });

  it('peek powers do not leak into other players\u2019 views', () => {
    const o = order();
    o[12] = c('draw9', H, 9);
    const e = setup(o, { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: 'p1' });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: 'p1' }); // 9 → PEEK_OTHER
    mustOk(e, {
      type: 'POWER_APPLY',
      playerId: 'p1',
      payload: { power: 'PEEK_OTHER', targetPlayerId: 'p2', cardId: 'b4' },
    });
    expect(e.getPlayerState('p1').knownCards.b4).toMatchObject({ id: 'b4', rank: 12 });
    expect(e.getPlayerState('p2').knownCards.b4).toBeUndefined();
    expect(e.getPlayerState('p3').knownCards.b4).toBeUndefined();
  });

  it('public events reveal a card ONLY when the rules say so (misflush is visible)', () => {
    const e = setup(order(), { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: 'p1' });
    mustOk(e, { type: 'KEEP_DRAWN', playerId: 'p1', handIndex: 3 }); // replaces a4 (7 → PEEK_OWN)
    mustOk(e, { type: 'POWER_APPLY', playerId: 'p1', payload: { power: 'PEEK_OWN', cardId: 'a3' } });
    const v2 = e.getPlayerState('p2');
    const evJson = JSON.stringify(v2.events);
    // Hidden hand content stays out of the log.
    expect(evJson).not.toContain('knownCards');
    // Before the failed flush, p3's d1 is private to nobody except its owner.
    expect(v2.knownCards.d1).toBeUndefined();

    // A wrong flush-other is a VISIBLE mistake: the guessed card is revealed
    // to everyone (embarrassing, like real life), then penalty applied.
    const res = e.handleAction({ type: 'FLUSH_OTHER', playerId: 'p2', targetPlayerId: 'p3', cardId: 'd1' });
    expect(res.ok).toBe(true);
    // A wrong flush of another player is PRIVATE: no rank in the event and
    // nobody's view (not even the guesser's) learns the card.
    const failEvent = e.getState().events.find((ev) => ev.type === 'FAILED_FLUSH_OTHER')!;
    expect(failEvent.payload).toMatchObject({ playerId: 'p2', cardId: 'd1' });
    expect((failEvent.payload as Record<string, unknown>).rank).toBeUndefined();
    const v2b = e.getPlayerState('p2');
    expect(v2b.knownCards.d1).toBeUndefined();
    const v1 = e.getPlayerState('p1');
    expect(v1.knownCards.d1).toBeUndefined();
  });

  it('reveal at round end grants everyone full knowledge', () => {
    const e = setup(order(), { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: 'p1' });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: 'p1' });
    mustOk(e, { type: 'CALL_CABO', playerId: 'p1' });
    mustOk(e, { type: 'DRAW', playerId: 'p2' });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: 'p2' });
    mustOk(e, { type: 'END_TURN', playerId: 'p2' });
    mustOk(e, { type: 'DRAW', playerId: 'p3' });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: 'p3' });
    mustOk(e, { type: 'END_TURN', playerId: 'p3' });
    const v1 = e.getPlayerState('p1');
    const remaining = Object.values(v1.handCardIds).flat();
    for (const id of remaining) {
      expect(v1.knownCards[id]).toBeDefined();
    }
    expect(v1.scores).toBeDefined();
  });

  it('restoreState preserves knowledge filtering', () => {
    const e = setup(order(), { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    const json = JSON.parse(JSON.stringify(e.getState()));
    const e2 = new CaboEngine();
    e2.restoreState(json);
    expect(Object.keys(e2.getPlayerState('p1').knownCards).sort()).toEqual(['a1', 'a2']);
  });

  it('Test Mode (revealAll) exposes every card, but is OFF by default', () => {
    const e = setup(order(), { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    // No revealAll → only the viewer's own knowledge leaks (hidden-info safe).
    const v1 = e.getPlayerState('p1');
    expect(Object.keys(v1.knownCards)).toEqual(['a1', 'a2']);
    // revealAll → every card on the table (hands, deck, discard) is exposed.
    const vm = e.getPlayerState('p1', { revealAll: true });
    const allIds = new Set<string>([
      ...Object.values(vm.knownCards).map((c) => c.id),
    ]);
    // p1's own 4 + p2's 4 + p3's 4 in this setup.
    expect(allIds.size).toBeGreaterThanOrEqual(12);
    expect(vm.knownCards.d4).toBeDefined(); // an opponent's hidden card
    expect(vm.knownCards.b3).toBeDefined(); // another opponent's hidden card
  });
});
