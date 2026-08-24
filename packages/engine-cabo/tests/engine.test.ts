import { describe, expect, it } from 'vitest';
import { standardDeck, createRng, shuffle } from '@game-night/shared';
import { CaboEngine, cardValue, powerForRank, DEFAULT_CABO_RULES, type CaboRules } from '../src/index.js';
import { S, H, D, CL, c, setup, peekAll, mustFail, mustOk, live } from './helpers.js';

const P1 = 'p1';
const P2 = 'p2';
const P3 = 'p3';

/** Vanilla 60-card pop order: 12 dealt + plenty of plain draws. */
function baseOrder(): ReturnType<typeof c>[] {
  const order = [
    // p1 hand: 3, 4, 2, 5
    c('a1', S, 3), c('b1', S, 4), c('d1', S, 2),
    c('a2', H, 4), c('b2', H, 5), c('d2', H, 3),
    c('a3', CL, 2), c('b3', CL, 4), c('d3', CL, 5),
    c('a4', D, 3), c('b4', D, 2), c('d4', D, 4),
    // draws (plain values)
    ...Array.from({ length: 40 }, (_, i) => c(`draw${i}`, i % 2 ? H : S, 2 + (i % 3))),
  ];
  return order;
}

describe('deck & dealing', () => {
  it('deals 4 cards to each player from a 52-card deck', () => {
    const e = new CaboEngine();
    e.createGame(
      [
        { id: 'x', name: 'X', seat: 0 },
        { id: 'y', name: 'Y', seat: 1 },
      ],
      {},
    );
    const s = e.getState();
    expect(s.hands.x).toHaveLength(4);
    expect(s.hands.y).toHaveLength(4);
    expect(s.deck.length).toBe(52 - 8);
    expect([...s.hands.x!, ...s.hands.y!, ...s.deck].map((card) => card.id).sort()).toEqual(
      standardDeck().map((card) => card.id).sort(),
    );
  });

  it('produces identical games from the same seed (deterministic test shuffles)', () => {
    const mk = () => {
      const e = new CaboEngine();
      e.createGame(
        [
          { id: 'x', name: 'X', seat: 0 },
          { id: 'y', name: 'Y', seat: 1 },
        ],
        { seed: 42 },
      );
      return e.getState();
    };
    const a = mk();
    const b = mk();
    expect(a.deck.map((card) => card.id)).toEqual(b.deck.map((card) => card.id));
  });

  it('shuffled deck differs from canonical order', () => {
    const rng = createRng(7);
    expect(shuffle(standardDeck(), rng).map((card) => card.id)).not.toEqual(
      standardDeck().map((card) => card.id),
    );
  });
});

describe('scoring', () => {
  it('scores rank values with red king 13 and black king -1', () => {
    expect(cardValue(c('k1', S, 13), DEFAULT_CABO_RULES)).toBe(-1);
    expect(cardValue(c('k2', CL, 13), DEFAULT_CABO_RULES)).toBe(-1);
    expect(cardValue(c('k3', H, 13), DEFAULT_CABO_RULES)).toBe(13);
    expect(cardValue(c('k4', D, 13), DEFAULT_CABO_RULES)).toBe(13);
    expect(cardValue(c('a', S, 1), DEFAULT_CABO_RULES)).toBe(1);
    expect(cardValue(c('j', H, 11), DEFAULT_CABO_RULES)).toBe(11);
    expect(cardValue(c('q', D, 12), DEFAULT_CABO_RULES)).toBe(12);
  });

  it('king scoring is configurable in one place', () => {
    const rules = { ...DEFAULT_CABO_RULES, kingValues: { red: 0, black: 0 } };
    expect(cardValue(c('k3', H, 13), rules)).toBe(0);
  });

  it('scores remaining hands at round end', () => {
    const e = setup(baseOrder(), { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    const scores = e.calculateScore();
    // p1 hand: 3,4,2,3 = 12 ; p2: 4,5,4,2 = 15 ; p3: 2,3,5,4 = 14
    expect(scores).toEqual({ p1: 12, p2: 15, p3: 14 });
  });
});

describe('power triggering rules', () => {
  it('maps rank bands to powers', () => {
    expect(powerForRank(5, DEFAULT_CABO_RULES)).toBeNull();
    expect(powerForRank(6, DEFAULT_CABO_RULES)).toBeNull();
    expect(powerForRank(7, DEFAULT_CABO_RULES)).toBe('PEEK_OWN');
    expect(powerForRank(8, DEFAULT_CABO_RULES)).toBe('PEEK_OWN');
    expect(powerForRank(9, DEFAULT_CABO_RULES)).toBe('PEEK_OTHER');
    expect(powerForRank(10, DEFAULT_CABO_RULES)).toBe('PEEK_OTHER');
    expect(powerForRank(11, DEFAULT_CABO_RULES)).toBe('BLIND_SWAP');
    expect(powerForRank(12, DEFAULT_CABO_RULES)).toBe('BLIND_SWAP');
    for (const r of [1, 2, 3, 4, 13] as const) {
      expect(powerForRank(r, DEFAULT_CABO_RULES)).toBeNull();
    }
  });

  it('host-toggle: when swapOthersEnabled is false, discarding a 5/6 triggers no power', () => {
    const order = baseOrder();
    order[12] = c('draw5', H, 5); // p1 draws a 5
    const e = setup(order, { rules: { swapOthersEnabled: false, endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    // The action ends at TURN_END; passing moves the turn on.
    expect(e.getState().phase).toBe('TURN_END');
    mustOk(e, { type: 'END_TURN', playerId: P1 });
    const s = e.getState();
    expect(s.pendingPower).toBeNull();
    expect(s.phase).toBe('TURN_DRAW');
    expect(s.players[s.currentTurn]!.id).toBe(P2);
  });
});

describe('turn flow', () => {
  it('starts in INITIAL_PEEK and waits for every player', () => {
    const e = setup(baseOrder());
    const s = e.getState();
    expect(s.phase).toBe('INITIAL_PEEK');
    mustOk(e, { type: 'PEEK_STARTING', playerId: P1, cardIndexes: [0, 1] });
    expect(s.phase).toBe('INITIAL_PEEK');
    mustFail(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'PEEK_STARTING', playerId: P2, cardIndexes: [0, 1] });
    mustOk(e, { type: 'PEEK_STARTING', playerId: P3, cardIndexes: [0, 1] });
    expect(s.phase).toBe('TURN_DRAW');
    expect(s.players[s.currentTurn]!.id).toBe(P1);
  });

  it('rejects wrong peek counts and duplicate indexes', () => {
    const e = setup(baseOrder());
    mustFail(e, { type: 'PEEK_STARTING', playerId: P1, cardIndexes: [0] });
    mustFail(e, { type: 'PEEK_STARTING', playerId: P1, cardIndexes: [0, 0] });
    mustFail(e, { type: 'PEEK_STARTING', playerId: P1, cardIndexes: [0, 99] });
  });

  it('expects cardIndexes at the TOP LEVEL of the action (not nested under payload)', () => {
    // Regression: the web client used to nest fields under `payload`, so the
    // engine read `cardIndexes.length` on undefined. It must succeed at the
    // top level and be rejected (not throw) when nested.
    const e = setup(baseOrder());
    mustOk(e, { type: 'PEEK_STARTING', playerId: P1, cardIndexes: [0, 1] });
    mustOk(e, { type: 'PEEK_STARTING', playerId: P2, cardIndexes: [0, 1] });
    // Nested/unknown shape is treated as an invalid action, never a crash.
    const bad = e.handleAction({
      type: 'PEEK_STARTING',
      playerId: P3,
      payload: { cardIndexes: [0, 1] },
    } as never);
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).not.toMatch(/undefined/i);
  });

  it('draw → flush drawn card (no power) advances the turn', () => {
    const e = setup(baseOrder());
    peekAll(e);
    const s = e.getState();
    mustOk(e, { type: 'DRAW', playerId: P1 });
    expect(s.phase).toBe('DRAW_DECISION');
    expect(s.drawnCard).not.toBeNull();
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    mustOk(e, { type: 'END_TURN', playerId: P1 });
    expect(s.phase).toBe('TURN_DRAW');
    expect(s.players[s.currentTurn]!.id).toBe(P2);
    expect(s.discard[s.discard.length - 1]!.rank).toBe(s.drawnCard?.rank ?? s.discard[s.discard.length - 1]!.rank);
  });

  it('draw + replace puts the OLD card on the discard pile', () => {
    const e = setup(baseOrder());
    peekAll(e);
    const before = e.getState().hands.p1!.slice();
    mustOk(e, { type: 'DRAW', playerId: P1 });
    const drawn = e.getState().drawnCard!;
    mustOk(e, { type: 'KEEP_DRAWN', playerId: P1, handIndex: 2 });
    mustOk(e, { type: 'END_TURN', playerId: P1 });
    const s = e.getState();
    expect(s.hands.p1![2]!.id).toBe(drawn.id);
    expect(s.hands.p1!.length).toBe(4);
    expect(s.discard[s.discard.length - 1]!.id).toBe(before[2]!.id);
    expect(s.players[s.currentTurn]!.id).toBe(P2);
  });

  it('rejects actions out of turn', () => {
    const e = setup(baseOrder());
    peekAll(e);
    mustFail(e, { type: 'DRAW', playerId: P2 });
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustFail(e, { type: 'DISCARD_DRAWN', playerId: P2 });
    mustFail(e, { type: 'KEEP_DRAWN', playerId: P3, handIndex: 0 });
  });

  it('rejects drawing twice and resolving before drawing', () => {
    const e = setup(baseOrder());
    peekAll(e);
    mustFail(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustFail(e, { type: 'DRAW', playerId: P1 });
  });
});

describe('house rule: the discarded card triggers its power', () => {
  it('direct flush of a drawn 9 triggers PEEK_OTHER', () => {
    const order = baseOrder();
    order[12] = c('draw9', H, 9); // p1's first draw
    const e = setup(order);
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    const s = e.getState();
    expect(s.phase).toBe('POWER_PENDING');
    expect(s.pendingPower).toMatchObject({ playerId: P1, power: 'PEEK_OTHER' });
  });

  it('keep drawn card: the REPLACED card (9) triggers the power, not the drawn card', () => {
    const order = baseOrder();
    order[6] = c('a3x', S, 9); // p1 hand index 2 becomes a 9 (deal index 6)
    const e = setup(order);
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'KEEP_DRAWN', playerId: P1, handIndex: 2 });
    const s = e.getState();
    expect(s.phase).toBe('POWER_PENDING');
    expect(s.pendingPower).toMatchObject({ playerId: P1, power: 'PEEK_OTHER' });
    expect(s.discard[s.discard.length - 1]!.rank).toBe(9);
  });

  it('the turn does not advance until the mandatory power is completed', () => {
    const order = baseOrder();
    order[12] = c('drawq', H, 12); // drawn queen
    const e = setup(order);
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    const s = e.getState();
    expect(s.pendingPower!.power).toBe('BLIND_SWAP');
    // No draw allowed while the power is pending.
    mustFail(e, { type: 'DRAW', playerId: P2 });
    // Completing the wrong power is rejected.
    mustFail(e, {
      type: 'POWER_APPLY',
      playerId: P1,
      payload: { power: 'PEEK_OWN', cardId: 'a1' },
    });
    mustOk(e, {
      type: 'POWER_APPLY',
      playerId: P1,
      payload: { power: 'BLIND_SWAP', ownCardId: 'a1', targetPlayerId: P2, targetCardId: 'b1' },
    });
    mustOk(e, { type: 'END_TURN', playerId: P1 });
    expect(e.getState().phase).toBe('TURN_DRAW');
    expect(e.getState().players[e.getState().currentTurn]!.id).toBe(P2);
  });

  it('rejects another player attempting the pending power', () => {
    const order = baseOrder();
    order[12] = c('draw8', H, 8);
    const e = setup(order);
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    mustFail(e, {
      type: 'POWER_APPLY',
      playerId: P2,
      payload: { power: 'PEEK_OWN', cardId: 'b1' },
    });
  });
});

describe('powers', () => {
  function pendingPowerFor(power: string, setupDraw: (o: ReturnType<typeof baseOrder>) => void, rules?: Partial<CaboRules>) {
    const order = baseOrder();
    setupDraw(order);
    const e = setup(order, { rules });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    expect(e.getState().pendingPower).toMatchObject({ playerId: P1, power });
    return e;
  }

  it('7/8 PEEK_OWN grants knowledge only to the actor', () => {
    const e = pendingPowerFor('PEEK_OWN', (o) => {
      o[12] = c('draw7', H, 7);
    });
    mustFail(e, {
      type: 'POWER_APPLY',
      playerId: P1,
      payload: { power: 'PEEK_OWN', cardId: 'b1' }, // not p1's card
    });
    mustOk(e, {
      type: 'POWER_APPLY',
      playerId: P1,
      payload: { power: 'PEEK_OWN', cardId: 'a3' },
    });
    const s = e.getState();
    expect(s.knowledge.p1).toContain('a3');
    expect(s.knowledge.p2).not.toContain('a3');
    expect(s.knowledge.p3).not.toContain('a3');
  });

  it('9/10 PEEK_OTHER grants knowledge of the target card only to the actor', () => {
    const e = pendingPowerFor('PEEK_OTHER', (o) => {
      o[12] = c('draw10', H, 10);
    });
    mustFail(e, {
      type: 'POWER_APPLY',
      playerId: P1,
      payload: { power: 'PEEK_OTHER', targetPlayerId: P2, cardId: 'a2' }, // a2 is p1's
    });
    mustOk(e, {
      type: 'POWER_APPLY',
      playerId: P1,
      payload: { power: 'PEEK_OTHER', targetPlayerId: P2, cardId: 'b3' },
    });
    const s = e.getState();
    expect(s.knowledge.p1).toContain('b3');
    expect(s.knowledge.p2).not.toContain('b3');
    expect(s.knowledge.p3).not.toContain('b3');
  });

  it('J/Q BLIND_SWAP exchanges own card with target card, values stay hidden', () => {
    const e = pendingPowerFor('BLIND_SWAP', (o) => {
      o[12] = c('drawj', H, 11);
    });
    mustOk(e, {
      type: 'POWER_APPLY',
      playerId: P1,
      payload: { power: 'BLIND_SWAP', ownCardId: 'a2', targetPlayerId: P3, targetCardId: 'd4' },
    });
    const s = e.getState();
    expect(s.hands.p1![1]!.id).toBe('d4');
    expect(s.hands.p3![3]!.id).toBe('a2');
    // Neither player learned the swapped values.
    expect(s.knowledge.p1).not.toContain('d4');
    expect(s.knowledge.p3).not.toContain('a2');
  });
});

describe('flushing own cards', () => {
  function withDiscardTop(rank: number) {
    const order = baseOrder();
    order[12] = c('drawX', H, rank);
    const e = setup(order, { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    mustOk(e, { type: 'END_TURN', playerId: P1 });
    return e;
  }

  it('flushes a matching own card; turn order untouched', () => {
    const e = withDiscardTop(3); // p2 has b2=5,b3=4,b4=2,b1=4 — none 3; p3 has d2=3
    const s = e.getState();
    expect(s.players[s.currentTurn]!.id).toBe(P2);
    // p3 (not the current player) flushes their known 3.
    const d2Idx = e.getState().hands.p3!.findIndex((x) => x?.id === 'd2');
    mustOk(e, { type: 'FLUSH_OWN', playerId: P3, cardIds: ['d2'] });
    const after = e.getState();
    expect(live(after.hands.p3!).length).toBe(3);
    // Position preserved: the flushed slot is now an empty gap, and every
    // other card keeps its exact index.
    expect(after.hands.p3![d2Idx]).toBeNull();
    expect(after.hands.p3!.filter((x) => x).map((x) => x!.id)).toEqual(['d1', 'd3', 'd4']);
    expect(after.discard[after.discard.length - 1]!.id).toBe('d2');
    expect(after.players[after.currentTurn]!.id).toBe(P2); // still p2's turn
    expect(after.phase).toBe('TURN_DRAW');
  });

  it('a non-matching card is a MISFLUSH: penalty card + card revealed to everyone', () => {
    const e = withDiscardTop(3);
    const deckBefore = e.getState().deck.length;
    const res = e.handleAction({ type: 'FLUSH_OWN', playerId: P3, cardIds: ['d1'] }); // d1 = 2 ≠ 3
    expect(res.ok).toBe(true);
    const s = e.getState();
    // Card stays in hand (nothing removed).
    expect(s.hands.p3!.some((c) => c?.id === 'd1')).toBe(true);
    // Penalty draw applied (default draw_one): no gap, so it appends.
    expect(live(s.hands.p3!).length).toBe(5);
    expect(s.deck.length).toBe(deckBefore - 1);
    expect(s.events.at(-1)!.type).toBe('PENALTY_DRAWN');
    // Everyone now knows the attempted (wrong) card — embarrassing, like real life.
    for (const pid of s.players.map((p) => p.id)) {
      expect(s.knowledge[pid]).toContain('d1');
    }
    // But the extra penalty card is secret — placed face-down, learned by no
    // one, not even the player who drew it.
    const penaltyCard = s.hands.p3![s.hands.p3!.length - 1]!;
    expect(s.knowledge.p3).not.toContain(penaltyCard.id);
    expect(s.knowledge.p1).not.toContain(penaltyCard.id);
    expect(s.knowledge.p2).not.toContain(penaltyCard.id);
  });

  it('a misflush does not remove matching cards in the same batch attempts', () => {
    // p1's hand has an 8 at a1 and a 2 at a3. Discard top is an 8; a batch
    // containing a non-matching card fails entirely (nothing removed).
    const order = baseOrder();
    order[0] = c('a1', S, 8); // p1 slot 0 = 8
    order[6] = c('a3', S, 3); // p1 slot 2 = 3 (does not match 8)
    order[12] = c('draw8', D, 8);
    const e = setup(order, { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 }); // discard top = 8
    const before = e.getState().hands.p1!.slice();
    const res = e.handleAction({ type: 'FLUSH_OWN', playerId: P1, cardIds: ['a1', 'a3'] });
    expect(res.ok).toBe(true);
    expect(e.getState().hands.p1!.length).toBe(before.length + 1); // +1 penalty, nothing removed
  });

  it('rejects unknown and duplicate cards', () => {
    const e = withDiscardTop(3);
    mustFail(e, { type: 'FLUSH_OWN', playerId: P3, cardIds: ['b2'] });
    mustFail(e, { type: 'FLUSH_OWN', playerId: P3, cardIds: ['d2', 'd2'] });
    mustFail(e, { type: 'FLUSH_OWN', playerId: P3, cardIds: [] });
  });

  it('flushes MULTIPLE matching cards at once', () => {
    const order = baseOrder();
    // Give p1 three 8s: positions 0,3,6,9 of the deal.
    order[0] = c('a1', S, 8);
    order[3] = c('a2', H, 8);
    order[6] = c('a3', CL, 8);
    order[12] = c('draw8', D, 8);
    const e = setup(order, { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 }); // 8 on discard
    mustOk(e, { type: 'FLUSH_OWN', playerId: P1, cardIds: ['a1', 'a2', 'a3'] });
    const s = e.getState();
    expect(live(s.hands.p1!).length).toBe(1);
    expect(s.discard.slice(-3).map((card) => card.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('a player reaching zero cards ends the round when configured', () => {
    const order = baseOrder();
    order[0] = c('a1', S, 4);
    order[3] = c('a2', H, 4);
    order[6] = c('a3', CL, 4);
    order[9] = c('a4', D, 4);
    order[12] = c('draw6', H, 4);
    const e = setup(order, { rules: { endRoundWhenPlayerHasNoCards: true } }); // legacy mode
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 }); // plain rank: turn ends
    mustOk(e, { type: 'FLUSH_OWN', playerId: P1, cardIds: ['a1', 'a2', 'a3', 'a4'] });
    const s = e.getState();
    expect(s.phase).toBe('ROUND_COMPLETE');
    expect(s.scores!.p1).toBe(0);
    expect(s.roundWinnerId).toBe(P1);
  });

  it('zero cards: no auto-Cabo — the player sits out and others continue', () => {
    const order = baseOrder();
    // p1's whole hand + first draw are all 4s (plain rank, no power).
    order[0] = c('a1', S, 4);
    order[3] = c('a2', H, 4);
    order[6] = c('a3', CL, 4);
    order[9] = c('a4', D, 4);
    order[12] = c('draw4', H, 4);
    const e = setup(order); // default rules
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    expect(e.getState().phase).toBe('TURN_END');
    mustOk(e, { type: 'FLUSH_OWN', playerId: P1, cardIds: ['a1', 'a2', 'a3', 'a4'] });
    // Ending the turn with zero cards does NOT call Cabo — the player just
    // sits out from now on (they cannot even draw).
    mustOk(e, { type: 'END_TURN', playerId: P1 });
    let st = e.getState();
    expect(st.cabo).toBeNull();
    expect(st.events.some((ev) => ev.type === 'CABO_CALLED')).toBe(false);
    expect(st.players[st.currentTurn]!.id).toBe(P2);
    expect(live(st.hands[P1]!).length).toBe(0);

    // p2 plays a normal turn then calls Cabo manually.
    mustOk(e, { type: 'DRAW', playerId: P2 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P2 });
    mustOk(e, { type: 'CALL_CABO', playerId: P2 });
    st = e.getState();
    expect(st.cabo).toMatchObject({ callerId: P2 });
    // The single final turn goes to the next ELIGIBLE player — never the
    // empty p1.
    const finalist = st.players[st.currentTurn]!.id;
    expect(finalist).toBe(P3);
    mustOk(e, { type: 'DRAW', playerId: finalist });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: finalist });
    mustOk(e, { type: 'END_TURN', playerId: finalist });
    const done = e.getState();
    expect(done.phase).toBe('ROUND_COMPLETE');
    expect(done.scores!.p1).toBe(0); // empty hand scores zero
  });

  it('cabo is called at the END of an action: calling before drawing is rejected', () => {
    const e = setup(baseOrder());
    peekAll(e);
    // At TURN_DRAW (before playing) calling is rejected.
    mustFail(e, { type: 'CALL_CABO', playerId: P1 });
    // Play the turn first…
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    expect(e.getState().phase).toBe('TURN_END');
    // …then the call goes through and everyone else gets one fresh round.
    mustOk(e, { type: 'CALL_CABO', playerId: P1 });
    const s = e.getState();
    expect(s.cabo).toMatchObject({ callerId: P1 });
    mustFail(e, { type: 'END_TURN', playerId: P2 }); // not p2's turn end
  });

  it('a penalty card fills the gap a flush left (positions never shuffle)', () => {
    const order = baseOrder();
    order[0] = c('a1', S, 4);
    order[3] = c('a2', H, 4);
    order[12] = c('draw4', H, 4);
    const e = setup(order);
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 }); // 4 on top, no power
    mustOk(e, { type: 'FLUSH_OWN', playerId: P1, cardIds: ['a1'] }); // gap at index 0
    // Now a misflush: the penalty card must slot into the gap, not append.
    mustOk(e, { type: 'FLUSH_OWN', playerId: P1, cardIds: ['a3'] }); // a3 = 2 → misflush
    const s = e.getState();
    expect(s.hands.p1![0]).not.toBeNull(); // gap refilled by the penalty
    expect(s.hands.p1!.filter((x) => x === null)).toHaveLength(0);
    expect(live(s.hands.p1!).length).toBe(4);
    expect(s.hands.p1!.slice(1, 4).map((x) => x!.id)).toEqual(['a2', 'a3', 'a4']);
  });
});

describe('flushing another player\u2019s card', () => {
  function setupTop(rank: number) {
    const order = baseOrder();
    order[12] = c('drawX', H, rank);
    const e = setup(order, { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    mustOk(e, { type: 'END_TURN', playerId: P1 });
    return e;
  }

  it('correct flush: card to discard, then flusher must transfer one of their own cards', () => {
    const e = setupTop(3); // p1 knows d2 (3, clubs) is p3's? No — p3 peeked. Use rank knowledge:
    // p3's d2 is a 3 (clubs) matching the 3 of hearts on top.
    const s = e.getState();
    expect(s.players[s.currentTurn]!.id).toBe(P2);
    mustOk(e, { type: 'FLUSH_OTHER', playerId: P1, targetPlayerId: P3, cardId: 'd2' });
    const mid = e.getState();
    expect(mid.phase).toBe('TRANSFER_PENDING');
    expect(live(mid.hands.p3!).length).toBe(3);
    expect(mid.hands.p3!.some((x) => x === null)).toBe(true); // gap where d2 was
    expect(mid.discard[mid.discard.length - 1]!.id).toBe('d2');
    // p2 cannot act for the pending transfer; p1 must give one of their own cards.
    mustFail(e, { type: 'TRANSFER_CARD', playerId: P2, cardId: 'b2' });
    const p1Before = live(mid.hands.p1!).length;
    mustOk(e, { type: 'TRANSFER_CARD', playerId: P1, cardId: 'a1' });
    const after = e.getState();
    expect(after.phase).toBe('TURN_DRAW');
    expect(after.players[after.currentTurn]!.id).toBe(P2); // turn preserved
    expect(live(after.hands.p3!).length).toBe(4); // gained p1's card
    // The transferred card fills the gap d2 left — same slot, nothing slid.
    expect(after.hands.p3![after.hands.p3!.findIndex((x) => x?.id === 'a1')]!.id).toBe('a1');
    expect(after.hands.p3!.filter((x) => x === null)).toHaveLength(0);
    expect(live(after.hands.p1!).length).toBe(p1Before - 1);
    expect(after.hands.p1!.find((card) => card?.id === 'a1')).toBeUndefined();
  });

  it('incorrect flush of another player: PRIVATE — nobody learns the card, penalty drawn', () => {
    const e = setupTop(3);
    const s = e.getState();
    const p3Hand = s.hands.p3!.slice();
    const deckCount = s.deck.length;
    // Wrong guess: processed outcome (not an error).
    const res = e.handleAction({ type: 'FLUSH_OTHER', playerId: P2, targetPlayerId: P3, cardId: 'd1' }); // d1 = 2
    expect(res.ok).toBe(true);
    const after = e.getState();
    // The invalid card stays with its owner (nothing removed).
    expect(after.hands.p3).toEqual(p3Hand);
    // The failed guess reveals NOTHING (fully private mistake).
    const last = after.events.at(-1)!;
    expect(last.type).toBe('PENALTY_DRAWN');
    const failEvent = after.events.filter((ev) => ev.type === 'FAILED_FLUSH_OTHER').at(-1)!;
    expect(failEvent.payload).toMatchObject({ playerId: P2, targetPlayerId: P3, cardId: 'd1' });
    expect((failEvent.payload as Record<string, unknown>).rank).toBeUndefined();
    // (p3 peeked d1 at the start so legitimately knows it — but the guesser
    // p2 and bystander p1 must NOT have learned anything.)
    expect(after.knowledge.p2).not.toContain('d1');
    expect(after.knowledge.p1).not.toContain('d1');
    // Penalty draw applied (default draw_one).
    expect(live(after.hands.p2!).length).toBe(5);
    expect(after.deck.length).toBe(deckCount - 1);
  });

  it('wrong-flush penalty is configurable (draw_two)', () => {
    const e = setup(baseOrder().map((card, i) => (i === 12 ? c('drawX', H, 3) : card)), {
      rules: { wrongFlushPenalty: 'draw_two', endRoundWhenPlayerHasNoCards: false },
    });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    const deckBefore = e.getState().deck.length;
    e.handleAction({ type: 'FLUSH_OTHER', playerId: P2, targetPlayerId: P3, cardId: 'd1' });
    expect(live(e.getState().hands.p2!).length).toBe(6);
    expect(e.getState().deck.length).toBe(deckBefore - 2);
  });

  it('rejects flushing your own card via FLUSH_OTHER or targeting a card not in the target hand', () => {
    const e = setupTop(3);
    mustFail(e, { type: 'FLUSH_OTHER', playerId: P1, targetPlayerId: P1, cardId: 'a1' });
    mustFail(e, { type: 'FLUSH_OTHER', playerId: P1, targetPlayerId: P3, cardId: 'b2' });
  });
});

describe('simultaneous flush attempts', () => {
  it('serializes two rapid flushes of the same rank without corrupting ownership', () => {
    const order = baseOrder();
    order[0] = c('a1', S, 8);
    order[1] = c('b1', H, 8);
    order[12] = c('draw8', D, 8);
    const e = setup(order, { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    // Two players "simultaneously" flush matching cards — both succeed
    // because the flushed rank keeps matching the (same-rank) pile top.
    mustOk(e, { type: 'FLUSH_OWN', playerId: P1, cardIds: ['a1'] });
    mustOk(e, { type: 'FLUSH_OWN', playerId: P2, cardIds: ['b1'] });
    const s = e.getState();
    expect(live(s.hands.p1!).length).toBe(3);
    expect(live(s.hands.p2!).length).toBe(3);
    expect(s.discard.slice(-2).map((card) => card.id)).toEqual(['a1', 'b1']);
    // No card exists in two hands (ownership integrity).
    const all = s.players.flatMap((p) => live(s.hands[p.id]!));
    expect(new Set(all.map((card) => card.id)).size).toBe(all.length);
  });

  it('misflush: a batch containing one wrong card removes nothing and draws a penalty', () => {
    const order = baseOrder();
    order[0] = c('a1', S, 8);
    order[3] = c('a2', H, 8);
    order[12] = c('draw8', D, 8);
    const e = setup(order, { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    const handBefore = e.getState().hands.p1!.slice();
    const deckBefore = e.getState().deck.length;
    const res = e.handleAction({ type: 'FLUSH_OWN', playerId: P1, cardIds: ['a1', 'a2', 'a3'] }); // a3 = 2
    expect(res.ok).toBe(true);
    // Nothing was removed from the hand (the whole attempt failed), but a
    // penalty card was drawn and the wrong card revealed to everyone.
    expect(e.getState().hands.p1!.length).toBe(handBefore.length + 1);
    expect(e.getState().deck.length).toBe(deckBefore - 1);
    expect(e.getState().knowledge.p2).toContain('a3');
  });
});

describe('cabo call & final turns', () => {
  it('caller is skipped, every other player gets one final turn, then reveal+score', () => {
    const e = setup(baseOrder(), { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    // Play a full action first, then call at TURN_END.
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    mustOk(e, { type: 'CALL_CABO', playerId: P1 });
    const s = e.getState();
    expect(s.cabo).toMatchObject({ callerId: P1 });
    expect(s.players[s.currentTurn]!.id).toBe(P2);

    // p2 final turn
    mustOk(e, { type: 'DRAW', playerId: P2 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P2 });
    mustOk(e, { type: 'END_TURN', playerId: P2 });
    expect(e.getState().players[e.getState().currentTurn]!.id).toBe(P3);
    // p3 final turn
    mustOk(e, { type: 'DRAW', playerId: P3 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P3 });
    mustOk(e, { type: 'END_TURN', playerId: P3 });
    // p1 (caller) gets no further turn — round ends.
    const done = e.getState();
    expect(done.phase).toBe('ROUND_COMPLETE');
    expect(done.scores).toEqual({ p1: 12, p2: 15, p3: 14 });
    expect(done.roundWinnerId).toBe(P1);
    expect(e.isGameFinished()).toBe(true);
  });

  it('rejects cabo when it is not your turn or already called', () => {
    const e = setup(baseOrder());
    peekAll(e);
    mustFail(e, { type: 'CALL_CABO', playerId: P2 });
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    mustOk(e, { type: 'CALL_CABO', playerId: P1 });
    mustFail(e, { type: 'CALL_CABO', playerId: P2 }); // already called
  });

  it('a tie is broken in favour of the cabo caller', () => {
    const order = baseOrder();
    // Everyone keeps equal-value hands: p1 and p2 both all-4s (score 16),
    // p3 all-4s too — a three-way tie, but p1 called cabo.
    for (let i = 0; i < 12; i++) order[i] = c(`card${i}`, i % 2 ? H : S, 4);
    order[12] = c('draw4', D, 4);
    const e = setup(order);
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    mustOk(e, { type: 'CALL_CABO', playerId: P1 });
    mustOk(e, { type: 'DRAW', playerId: P2 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P2 });
    mustOk(e, { type: 'END_TURN', playerId: P2 });
    mustOk(e, { type: 'DRAW', playerId: P3 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P3 });
    mustOk(e, { type: 'END_TURN', playerId: P3 });
    const done = e.getState();
    expect(done.phase).toBe('ROUND_COMPLETE');
    const vals = Object.values(done.scores!);
    expect(new Set(vals).size).toBe(1); // genuinely tied scores
    expect(done.roundWinnerId).toBe(P1); // caller takes the tie
  });

  it('swap powers are SKIPPED when every opponent has no cards (no dead-lock)', () => {
    const order2 = baseOrder();
    for (let i = 0; i < 12; i++) order2[i] = c(`k${i}`, i % 2 ? H : S, 4);
    order2[12] = c('drawJ', H, 11);
    const e2 = setup(order2, { players: 2 });
    const ids = e2.getState().players.map((p) => p.id);
    const [q1, q2] = ids;
    for (const pid of ids) mustOk(e2, { type: 'PEEK_STARTING', playerId: pid, cardIndexes: [1, 3] });
    // q1 keeps his 4s and ends the turn.
    mustOk(e2, { type: 'DRAW', playerId: q1 });
    mustOk(e2, { type: 'KEEP_DRAWN', playerId: q1, handIndex: 0 });
    mustOk(e2, { type: 'END_TURN', playerId: q1 });
    // q2 keeps a 4 then flushes ALL four 4s — hand empty, sits out.
    mustOk(e2, { type: 'DRAW', playerId: q2 });
    mustOk(e2, { type: 'KEEP_DRAWN', playerId: q2, handIndex: 0 });
    const q2Hand = e2.getState().hands[q2]!.filter((c): c is NonNullable<typeof c> => !!c);
    mustOk(e2, { type: 'FLUSH_OWN', playerId: q2, cardIds: q2Hand.map((c) => c.id).slice(0, 4) });
    mustOk(e2, { type: 'END_TURN', playerId: q2 });
    expect(e2.getState().cabo).toBeNull(); // no auto-cabo any more
    // q1 draws the J — a BLIND_SWAP with the ONLY other player holding zero
    // cards is impossible, so the power is SKIPPED, no dead-lock.
    mustOk(e2, { type: 'DRAW', playerId: q1 });
    mustOk(e2, { type: 'DISCARD_DRAWN', playerId: q1 });
    const s2 = e2.getState();
    expect(s2.pendingPower).toBeNull(); // skipped, not pending
    expect(s2.phase).toBe('TURN_END');
    // With nobody else able to act, q1 closes the round deliberately.
    mustOk(e2, { type: 'CALL_CABO', playerId: q1 });
    // Nobody else can act (q2 is empty) — calling Cabo ends it immediately.
    expect(e2.getState().phase).toBe('ROUND_COMPLETE');
  });

  it('cabo can be disabled by rules', () => {
    const e = setup(baseOrder(), { rules: { cabo: { enabled: false, callerGetsFinalTurn: false, othersFinalTurns: 1 } } });
    peekAll(e);
    mustFail(e, { type: 'CALL_CABO', playerId: P1 });
  });
});

describe('deck exhaustion', () => {
  it('reshuffles the discard pile (keeping the top) when the deck runs out', () => {
    const filler = Array.from({ length: 20 }, (_, i) => c(`f${i}`, S, 2 + (i % 2)));
    const order = [...filler]; // 20 cards: 12 dealt, 8 draws left
    const e = setup(order, { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    // Burn through draws: each turn draws + discards (rank 2/3, no powers).
    for (let i = 0; i < 8; i++) {
      const pid = e.getState().players[e.getState().currentTurn]!.id;
      mustOk(e, { type: 'DRAW', playerId: pid });
      mustOk(e, { type: 'DISCARD_DRAWN', playerId: pid });
      mustOk(e, { type: 'END_TURN', playerId: pid });
    }
    const s = e.getState();
    expect(s.deck.length).toBe(0);
    expect(s.discard.length).toBeGreaterThan(1);
    const pid = s.players[s.currentTurn]!.id;
    const discardBefore = s.discard.length;
    mustOk(e, { type: 'DRAW', playerId: pid });
    const after = e.getState();
    expect(after.events.some((ev) => ev.type === 'DECK_RESHUFFLED')).toBe(true);
    expect(after.discard.length).toBe(1); // only the preserved top
    // 8 cards were in the discard: 1 kept as top, 7 shuffled in, 1 drawn.
    expect(after.deck.length).toBe(discardBefore - 2);
  });
});

describe('restore / reconnect', () => {
  it('state round-trips through JSON and keeps the game playable', () => {
    const e = setup(baseOrder(), { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    mustOk(e, { type: 'DRAW', playerId: P1 });
    const json = JSON.stringify(e.getState());

    const e2 = new CaboEngine();
    e2.restoreState(JSON.parse(json));
    expect(e2.getState().revision).toBe(e.getState().revision);
    expect(e2.getPlayerState(P1).drawnCard!.id).toBe('draw0');
    mustOk(e2, { type: 'KEEP_DRAWN', playerId: P1, handIndex: 0 });
    mustOk(e2, { type: 'END_TURN', playerId: P1 });
    expect(e2.getState().players[e2.getState().currentTurn]!.id).toBe(P2);
  });
});

describe('full game playthrough', () => {
  it('plays a complete game through engine actions only', () => {
    const order = baseOrder();
    order[12] = c('draw7', H, 7);
    const e = setup(order, { rules: { endRoundWhenPlayerHasNoCards: false } });
    peekAll(e);
    // A few normal turns with mixed decisions.
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 }); // 7 → PEEK_OWN
    mustOk(e, { type: 'POWER_APPLY', playerId: P1, payload: { power: 'PEEK_OWN', cardId: 'a4' } });
    mustOk(e, { type: 'END_TURN', playerId: P1 });
    mustOk(e, { type: 'DRAW', playerId: P2 });
    mustOk(e, { type: 'KEEP_DRAWN', playerId: P2, handIndex: 3 }); // replaces a 2 → no power
    mustOk(e, { type: 'END_TURN', playerId: P2 });
    mustOk(e, { type: 'DRAW', playerId: P3 });
    mustOk(e, { type: 'KEEP_DRAWN', playerId: P3, handIndex: 0 }); // replaces a 2 → no power
    mustOk(e, { type: 'END_TURN', playerId: P3 });
    // p1 plays their action then calls cabo; p2 and p3 take final turns.
    mustOk(e, { type: 'DRAW', playerId: P1 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P1 });
    mustOk(e, { type: 'CALL_CABO', playerId: P1 });
    mustOk(e, { type: 'DRAW', playerId: P2 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P2 });
    mustOk(e, { type: 'END_TURN', playerId: P2 });
    mustOk(e, { type: 'DRAW', playerId: P3 });
    mustOk(e, { type: 'DISCARD_DRAWN', playerId: P3 });
    mustOk(e, { type: 'END_TURN', playerId: P3 });
    const s = e.getState();
    expect(s.phase).toBe('ROUND_COMPLETE');
    expect(e.isGameFinished()).toBe(true);
    // Every card accounted for: hands + deck + discard = 52.
    const total =
      s.players.reduce((n, p) => n + s.hands[p.id]!.length, 0) + s.deck.length + s.discard.length;
    expect(total).toBe(52);
  });
});
