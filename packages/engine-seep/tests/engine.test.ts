import { describe, expect, it } from 'vitest';
import { standardDeck, type Card, type Rank, type Suit } from '@game-night/shared';
import {
  SeepEngine,
  DEFAULT_SEEP_RULES,
  captureValue,
  cardPoints,
  totalDeckPoints,
  teamOfSeat,
  reachableSubsetSum,
  mergeSeepRules,
  type SeepAction,
  type SeepRules,
  type SeepState,
} from '../src/index.js';

const N = 'n'; // seat 0 — team 0
const E = 'e'; // seat 1 — team 1
const S = 's'; // seat 2 — team 0
const W = 'w'; // seat 3 — team 1
const ORDER = [N, E, S, W] as const;

const c = (id: string, suit: Suit, rank: Rank): Card => ({ id, suit, rank });

function players() {
  return ORDER.map((id, i) => ({ id, name: id.toUpperCase(), seat: i }));
}

function fresh(opts: Parameters<SeepEngine['createGame']>[1] = {}) {
  const e = new SeepEngine();
  e.createGame(players(), opts);
  return e;
}

/**
 * Build a forced deck from a deal layout. createGame pops from the END of
 * the array, so the deal order (first pop first) is reversed into the deck.
 * Each hand supplies `cardsPerBatch * maxBatches` cards; `table` the
 * starting face-up cards.
 */
function forcedDeck(
  hands: Record<string, Card[]>,
  table: Card[],
  rules: Pick<SeepRules, 'cardsPerBatch' | 'maxBatches'> = DEFAULT_SEEP_RULES,
): Card[] {
  const dealOrder: Card[] = [];
  for (let batch = 0; batch < rules.maxBatches; batch++) {
    for (let round = 0; round < rules.cardsPerBatch; round++) {
      for (const pid of ORDER) dealOrder.push(hands[pid]![batch * 4 + round]!);
    }
  }
  dealOrder.push(...table);
  return dealOrder.reverse();
}

/** Cards from the standard deck that are not in `used` (unique ids). */
function filler(count: number, usedIds: Set<string>, start = 0): Card[] {
  const out: Card[] = [];
  for (const card of standardDeck().slice(start)) {
    if (out.length >= count) break;
    if (!usedIds.has(card.id)) out.push(card);
  }
  for (const card of out) usedIds.add(card.id);
  return out;
}

/** Tiny legal driver: capture the first found option, else lay down. */
function bestAction(e: SeepEngine, pid: string): SeepAction {
  const s = e.getState();
  const hand = s.hands[pid]!;
  const card = hand[0]!;
  const v = captureValue(card);
  // single match
  const single = s.tableLoose.find((t) => captureValue(t) === v);
  if (single) return { type: 'PLAY_CARD', playerId: pid, cardId: card.id, intent: { kind: 'CAPTURE', tableCardIds: [single.id] } };
  // subset sum (brute force over the small table)
  const loose = s.tableLoose;
  for (let mask = 1; mask < 1 << loose.length; mask++) {
    const ids: string[] = [];
    let sum = 0;
    for (let i = 0; i < loose.length; i++) {
      if (mask & (1 << i)) {
        ids.push(loose[i]!.id);
        sum += captureValue(loose[i]!);
      }
    }
    if (sum === v) return { type: 'PLAY_CARD', playerId: pid, cardId: card.id, intent: { kind: 'CAPTURE', tableCardIds: ids } };
  }
  // house capture
  const house = s.houses.find((h) => h.total === v);
  if (house) return { type: 'PLAY_CARD', playerId: pid, cardId: card.id, intent: { kind: 'CAPTURE_HOUSE', houseId: house.id } };
  return { type: 'PLAY_CARD', playerId: pid, cardId: card.id, intent: { kind: 'LAY_DOWN' } };
}

/** Play `count` legal turns with the greedy driver. */
function autoPlay(e: SeepEngine, count: number): void {
  for (let i = 0; i < count && !e.isGameFinished(); i++) {
    const s = e.getState();
    const pid = s.players[s.currentTurn]!.id;
    const res = e.handleAction(bestAction(e, pid));
    if (!res.ok) throw new Error(`driver play rejected: ${res.error}`);
  }
}

/** Deal tuned for tiny forced decks: one card per player + `table` face-up. */
function tinyDeal(hands: Record<string, Card[]>, table: Card[]) {
  return fresh({
    forcedDeck: forcedDeck(hands, table, { cardsPerBatch: 1, maxBatches: 1 }),
    rules: { cardsPerBatch: 1, maxBatches: 1, tableStartCards: table.length },
    firstTurnSeat: 0,
  });
}

/** Standard-shape deal used by the view/restore suites (16+4 card deck). */
function viewDeal() {
  const used = new Set<string>(['n1', 'e1', 's1', 'w1', 't1', 't2', 't3', 't4']);
  const hands = {
    [N]: [c('n1', 'diamonds', 5), ...filler(3, used, 20)],
    [E]: [c('e1', 'clubs', 6), ...filler(3, used, 32)],
    [S]: [c('s1', 'hearts', 7), ...filler(3, used, 8)],
    [W]: [c('w1', 'spades', 12), ...filler(3, used, 44)],
  };
  const table = [c('t1', 'spades', 9), c('t2', 'hearts', 2), c('t3', 'clubs', 3), c('t4', 'diamonds', 4)];
  const e = fresh({
    forcedDeck: forcedDeck(hands, table, { cardsPerBatch: 4, maxBatches: 1 }),
    rules: { cardsPerBatch: 4, maxBatches: 1 },
    firstTurnSeat: 0,
  });
  // North captures t2+t3 (2+3=5) with n1.
  e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'CAPTURE', tableCardIds: ['t2', 't3'] } });
  // East lays e1.
  e.handleAction({ type: 'PLAY_CARD', playerId: E, cardId: 'e1', intent: { kind: 'LAY_DOWN' } });
  return e;
}

describe('deal & setup', () => {
  it('deals batch 1: four cards each plus four table cards', () => {
    const e = fresh();
    const s = e.getState();
    for (const pid of ORDER) expect(s.hands[pid]).toHaveLength(4);
    expect(s.tableLoose).toHaveLength(4);
    expect(s.deck).toHaveLength(52 - 20);
    expect(s.batchesDealt).toBe(1);
    expect(s.phase).toBe('TURN_PLAY');
  });

  it('accounts for every card in the deck', () => {
    const e = fresh();
    const s = e.getState();
    const all = [
      ...s.deck,
      ...s.tableLoose,
      ...ORDER.flatMap((pid) => s.hands[pid]!),
    ].map((card) => card.id).sort();
    expect(all).toEqual(standardDeck().map((card) => card.id).sort());
  });

  it('is deterministic from a seed', () => {
    const a = fresh({ seed: 99 }).getState();
    const b = fresh({ seed: 99 }).getState();
    expect(a.deck.map((card) => card.id)).toEqual(b.deck.map((card) => card.id));
    expect(a.currentTurn).toBe(b.currentTurn);
    expect(a.tableLoose.map((card) => card.id)).toEqual(b.tableLoose.map((card) => card.id));
  });

  it('requires exactly four players', () => {
    const e = new SeepEngine();
    expect(() =>
      e.createGame([
        { id: 'x', name: 'X', seat: 0 },
        { id: 'y', name: 'Y', seat: 1 },
      ]),
    ).toThrow(/exactly 4/);
  });

  it('honours a forced first turn seat', () => {
    expect(fresh({ firstTurnSeat: 2 }).getState().currentTurn).toBe(2);
  });
});

describe('scoring table (default house rules)', () => {
  it('puts exactly 100 points in the deck', () => {
    expect(totalDeckPoints(DEFAULT_SEEP_RULES)).toBe(100);
  });

  it('scores spades by pip with faces at 10 and other aces at 5', () => {
    expect(cardPoints(c('a', 'spades', 7), DEFAULT_SEEP_RULES)).toBe(7);
    expect(cardPoints(c('a', 'spades', 1), DEFAULT_SEEP_RULES)).toBe(1);
    expect(cardPoints(c('a', 'spades', 11), DEFAULT_SEEP_RULES)).toBe(10);
    expect(cardPoints(c('a', 'spades', 13), DEFAULT_SEEP_RULES)).toBe(10);
    expect(cardPoints(c('a', 'hearts', 1), DEFAULT_SEEP_RULES)).toBe(5);
    expect(cardPoints(c('a', 'clubs', 1), DEFAULT_SEEP_RULES)).toBe(5);
    expect(cardPoints(c('a', 'diamonds', 3), DEFAULT_SEEP_RULES)).toBe(0);
    expect(cardPoints(c('a', 'diamonds', 13), DEFAULT_SEEP_RULES)).toBe(0);
  });

  it('supports explicit overrides', () => {
    const rules = mergeSeepRules({
      pointRules: { overrides: [{ suit: 'diamonds', rank: 10, points: 3 }], spadesPip: false, otherAcesPoints: 0 },
    });
    expect(cardPoints(c('x', 'diamonds', 10), rules)).toBe(3);
    expect(cardPoints(c('x', 'spades', 7), rules)).toBe(0);
    expect(cardPoints(c('x', 'hearts', 1), rules)).toBe(0);
  });

  it('maps seats to teams by parity', () => {
    expect(teamOfSeat(0)).toBe(0);
    expect(teamOfSeat(1)).toBe(1);
    expect(teamOfSeat(2)).toBe(0);
    expect(teamOfSeat(3)).toBe(1);
  });
});

describe('subset sums', () => {
  it('finds reachable sums and rejects impossible ones', () => {
    const t = [c('1', 'hearts', 2), c('2', 'hearts', 3), c('3', 'hearts', 4), c('4', 'hearts', 5)];
    expect(reachableSubsetSum(t, 2)).toBe(true);
    expect(reachableSubsetSum(t, 9)).toBe(true); // 2+3+4
    expect(reachableSubsetSum(t, 10)).toBe(true); // 2+3+5
    expect(reachableSubsetSum(t, 8)).toBe(true); // 3+5
    expect(reachableSubsetSum(t, 1)).toBe(false);
    expect(reachableSubsetSum(t, 13)).toBe(false);
    expect(reachableSubsetSum([], 2)).toBe(false);
  });
});

describe('captures', () => {
  it('captures a single card of equal value', () => {
    const used = new Set<string>();
    const hands = {
      [N]: [c('n1', 'diamonds', 5), ...filler(3, used)],
      [E]: filler(4, used),
      [S]: filler(4, used),
      [W]: filler(4, used),
    };
    used.add('n1');
    const table = [c('t1', 'hearts', 5), c('t2', 'spades', 9), c('t3', 'clubs', 2), c('t4', 'diamonds', 11)];
    const e = fresh({ forcedDeck: forcedDeck(hands, table, { cardsPerBatch: 4, maxBatches: 1 }), firstTurnSeat: 0 });
    const res = e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'CAPTURE', tableCardIds: ['t1'] } });
    expect(res.ok).toBe(true);
    const s = e.getState();
    expect(s.tableLoose.map((x) => x.id)).toEqual(['t2', 't3', 't4']);
    expect(s.captures[N]!.map((x) => x.id)).toEqual(['n1', 't1']);
    expect(s.lastCaptureTeam).toBe(0);
    expect(s.currentTurn).toBe(1);
    expect(res.events.some((ev) => ev.type === 'PLAY_CAPTURE')).toBe(true);
  });

  it('captures a set summing to the played value', () => {
    const used = new Set<string>();
    const hands = {
      [N]: [c('n1', 'diamonds', 8), ...filler(3, used)],
      [E]: filler(4, used),
      [S]: filler(4, used),
      [W]: filler(4, used),
    };
    const table = [c('t1', 'hearts', 3), c('t2', 'spades', 5), c('t3', 'clubs', 12), c('t4', 'diamonds', 13)];
    const e = fresh({ forcedDeck: forcedDeck(hands, table, { cardsPerBatch: 4, maxBatches: 1 }), firstTurnSeat: 0 });
    const res = e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'CAPTURE', tableCardIds: ['t1', 't2'] } });
    expect(res.ok).toBe(true);
    const s = e.getState();
    expect(s.captures[N]).toHaveLength(3);
    expect(s.tableLoose.map((x) => x.id)).toEqual(['t3', 't4']);
  });

  it('rejects wrong sums, foreign cards and duplicates', () => {
    const used = new Set<string>();
    const hands = {
      [N]: [c('n1', 'diamonds', 8), ...filler(3, used)],
      [E]: filler(4, used),
      [S]: filler(4, used),
      [W]: filler(4, used),
    };
    const table = [c('t1', 'hearts', 3), c('t2', 'spades', 5), c('t3', 'clubs', 12), c('t4', 'diamonds', 13)];
    const e = fresh({ forcedDeck: forcedDeck(hands, table, { cardsPerBatch: 4, maxBatches: 1 }), firstTurnSeat: 0 });
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'CAPTURE', tableCardIds: ['t1'] } }).ok).toBe(false);
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'CAPTURE', tableCardIds: ['t1', 't3'] } }).ok).toBe(false);
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'CAPTURE', tableCardIds: ['t1', 't1'] } }).ok).toBe(false);
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'nope', intent: { kind: 'LAY_DOWN' } }).ok).toBe(false);
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: E, cardId: 'n1', intent: { kind: 'LAY_DOWN' } }).ok).toBe(false);
    // The real capture still works after the rejections.
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'CAPTURE', tableCardIds: ['t1', 't2'] } }).ok).toBe(true);
  });

  it('awards a seep when one play clears the whole table', () => {
    const used = new Set<string>();
    const hands = {
      [N]: [c('n1', 'diamonds', 9), ...filler(3, used)],
      [E]: filler(4, used),
      [S]: filler(4, used),
      [W]: filler(4, used),
    };
    const table = [c('t1', 'spades', 9), c('t2', 'hearts', 2), c('t3', 'clubs', 3), c('t4', 'diamonds', 4)];
    const e = fresh({ forcedDeck: forcedDeck(hands, table, { cardsPerBatch: 4, maxBatches: 1 }), firstTurnSeat: 0 });
    const res = e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'CAPTURE', tableCardIds: ['t2', 't3', 't4'] } });
    // t1 (9♠) also matches — capturing only 2+3+4+9? the play above takes the
    // three others; table still holds t1 → no sweep yet.
    expect(res.ok).toBe(true);
    let s = e.getState();
    expect(s.sweeps[0]).toBe(0);

    // Rebuild a fresh deal where the single capture takes the whole table.
    const used2 = new Set<string>(['x1']);
    const hands2 = {
      [N]: [c('x1', 'diamonds', 9), ...filler(3, used2)],
      [E]: filler(4, used2),
      [S]: filler(4, used2),
      [W]: filler(4, used2),
    };
    const table2 = [c('y1', 'hearts', 2), c('y2', 'clubs', 3), c('y3', 'spades', 4)];
    const e2 = fresh({
      forcedDeck: forcedDeck(hands2, table2, { cardsPerBatch: 4, maxBatches: 1 }),
      rules: { cardsPerBatch: 4, maxBatches: 1, tableStartCards: 3 },
      firstTurnSeat: 0,
    });
    const res2 = e2.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'x1', intent: { kind: 'CAPTURE', tableCardIds: ['y1', 'y2', 'y3'] } });
    expect(res2.ok).toBe(true);
    s = e2.getState();
    expect(s.tableLoose).toHaveLength(0);
    expect(s.houses).toHaveLength(0);
    expect(s.sweeps[0]).toBe(1);
    expect(res2.events.some((ev) => ev.type === 'SEEP_SWEEP')).toBe(true);
    // With an empty table the next player has nothing to capture: lay only.
    expect(e2.handleAction({ type: 'PLAY_CARD', playerId: E, cardId: (e2.getState().hands[E]![0] as Card).id, intent: { kind: 'CAPTURE', tableCardIds: [] } }).ok).toBe(false);
    const laid = e2.handleAction({ type: 'PLAY_CARD', playerId: E, cardId: (e2.getState().hands[E]![0] as Card).id, intent: { kind: 'LAY_DOWN' } });
    expect(laid.ok).toBe(true);
  });
});

describe('must-capture rule', () => {
  it('rejects laying down or building with a card that can capture', () => {
    const used = new Set<string>();
    const hands = {
      [N]: [c('n1', 'diamonds', 5), c('n2', 'diamonds', 10), ...filler(2, used)],
      [E]: filler(4, used),
      [S]: filler(4, used),
      [W]: filler(4, used),
    };
    const table = [c('t1', 'hearts', 5), c('t2', 'spades', 12), c('t3', 'clubs', 4), c('t4', 'diamonds', 6)];
    const e = fresh({ forcedDeck: forcedDeck(hands, table, { cardsPerBatch: 4, maxBatches: 1 }), firstTurnSeat: 0 });
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'LAY_DOWN' } }).error).toMatch(/must capture/);
    // n2 (10) + t4 (6) = 16? no — 10 alone can capture nothing, but n1 can,
    // and BUILD with n1 is blocked by must-capture too.
    expect(
      e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'BUILD', tableCardIds: ['t3'], total: 9 } }).error,
    ).toMatch(/must capture/);
  });
});

describe('houses', () => {
  function houseDeal() {
    const used = new Set<string>(['n1', 'n2', 'e1', 's1', 's2', 'w1', 't1', 't2', 't3', 't4']);
    const hands = {
      [N]: [c('n1', 'diamonds', 6), c('n2', 'diamonds', 11), ...filler(2, used)],
      [E]: [c('e1', 'clubs', 11), ...filler(3, used)],
      [S]: [c('s1', 'hearts', 11), c('s2', 'spades', 11), ...filler(2, used)],
      [W]: [c('w1', 'clubs', 6), ...filler(3, used)],
    };
    const table = [c('t1', 'spades', 5), c('t2', 'hearts', 2), c('t3', 'clubs', 12), c('t4', 'diamonds', 13)];
    return fresh({ forcedDeck: forcedDeck(hands, table, { cardsPerBatch: 4, maxBatches: 1 }), firstTurnSeat: 0 });
  }

  it('builds, raises, and is captured by an opponent', () => {
    const e = houseDeal();
    // North builds a house of 11 from n1(6) + t1(5), backed by n2(11).
    let res = e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'BUILD', tableCardIds: ['t1'], total: 11 } });
    expect(res.ok).toBe(true);
    let s = e.getState();
    expect(s.houses).toHaveLength(1);
    expect(s.houses[0]).toMatchObject({ total: 11, ownerTeam: 0 });
    expect(s.houses[0]!.cards.map((x) => x.id)).toEqual(['n1', 't1']);
    // East (team 1) cannot raise an opponent house.
    expect(
      e.handleAction({ type: 'PLAY_CARD', playerId: E, cardId: 'e1', intent: { kind: 'RAISE_HOUSE', houseId: 'h-1' } }).error,
    ).toMatch(/only your team/);
    // East CAN capture it.
    res = e.handleAction({ type: 'PLAY_CARD', playerId: E, cardId: 'e1', intent: { kind: 'CAPTURE_HOUSE', houseId: 'h-1' } });
    expect(res.ok).toBe(true);
    s = e.getState();
    expect(s.houses).toHaveLength(0);
    expect(s.captures[E]!.map((x) => x.id)).toEqual(['e1', 'n1', 't1']);
    expect(s.lastCaptureTeam).toBe(1);
  });

  it('lets the owning team raise with a backed card', () => {
    const e = houseDeal();
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'BUILD', tableCardIds: ['t1'], total: 11 } }).ok).toBe(true);
    // East (opponent) must play first — a harmless lay keeps the house alone.
    const eastCard = e.getState().hands[E]![1]!; // a filler, captures nothing
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: E, cardId: eastCard.id, intent: { kind: 'LAY_DOWN' } }).ok).toBe(true);
    // South is north's partner (team 0): raise with s1(11), backed by s2(11).
    const res = e.handleAction({ type: 'PLAY_CARD', playerId: S, cardId: 's1', intent: { kind: 'RAISE_HOUSE', houseId: 'h-1' } });
    expect(res.ok).toBe(true);
    const s = e.getState();
    expect(s.houses[0]!.cards.map((x) => x.id)).toEqual(['n1', 't1', 's1']);
  });

  it('rejects builds without a backing card, bad totals or wrong sums', () => {
    const e = houseDeal();
    // Wrong declared total (n1 6 + t1 5 = 11, not 12).
    expect(
      e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'BUILD', tableCardIds: ['t1'], total: 12 } }).ok,
    ).toBe(false);
    // Total out of range: n1(6)+t1(5)+… declared 14.
    expect(
      e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n2', intent: { kind: 'BUILD', tableCardIds: ['t3'], total: 23 } }).ok,
    ).toBe(false);
    // n2 (11) + t1 (5) = 16 — out of range regardless of the declaration.
    expect(
      e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n2', intent: { kind: 'BUILD', tableCardIds: ['t1'], total: 16 } }).ok,
    ).toBe(false);
    // No backing: after building with n2 (the only other 11 is in the deck…)
    // — craft directly: build of 12 from n2(11)+t2(2) needs another 12 in
    // hand; north has none.
    expect(
      e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n2', intent: { kind: 'BUILD', tableCardIds: ['t2'], total: 13 } }).ok,
    ).toBe(false);
    // Building with a card that can capture is blocked by must-capture:
    // n1(6) can capture nothing here… t1=5,t2=2,t3=12,t4=13 — no 6. OK,
    // the successful build in the first test already proves the path.
  });

  it('refuses raises without a remaining backing card', () => {
    const used = new Set<string>(['n1', 'n2', 's1', 't1', 't2', 't3', 't4', 'e1', 'w1']);
    const hands = {
      [N]: [c('n1', 'diamonds', 6), c('n2', 'diamonds', 11), ...filler(2, used)],
      [E]: [c('e1', 'clubs', 3), ...filler(3, used)],
      [S]: [c('s1', 'hearts', 11), ...filler(3, used)],
      [W]: [c('w1', 'clubs', 7), ...filler(3, used)],
    };
    const table = [c('t1', 'spades', 5), c('t2', 'hearts', 2), c('t3', 'clubs', 12), c('t4', 'diamonds', 13)];
    const e = fresh({ forcedDeck: forcedDeck(hands, table, { cardsPerBatch: 4, maxBatches: 1 }), firstTurnSeat: 0 });
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'BUILD', tableCardIds: ['t1'], total: 11 } }).ok).toBe(true);
    // East plays a harmless filler first (turn order).
    const eastCard = e.getState().hands[E]![1]!;
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: E, cardId: eastCard.id, intent: { kind: 'LAY_DOWN' } }).ok).toBe(true);
    // South raises with s1(11) but holds no other 11 → rejected.
    expect(
      e.handleAction({ type: 'PLAY_CARD', playerId: S, cardId: 's1', intent: { kind: 'RAISE_HOUSE', houseId: 'h-1' } }).error,
    ).toMatch(/backing|hold another/i);
  });
});

describe('deal progression', () => {
  it('replenishes hands when everyone is empty and finishes after the last batch', () => {
    const e = fresh({ seed: 7, firstTurnSeat: 0 });
    // Drive the whole deal (48 plays max) with the legal greedy driver.
    autoPlay(e, 64);
    const s = e.getState();
    expect(s.phase).toBe('ROUND_COMPLETE');
    expect(s.batchesDealt).toBe(3);
    expect(s.tableLoose).toHaveLength(0);
    expect(s.houses).toHaveLength(0);
    const captured = ORDER.flatMap((pid) => s.captures[pid]!);
    expect(captured).toHaveLength(52);
    expect(s.teamScores).not.toBeNull();
    // Scores = card points + sweep bonuses — always consistent.
    const tp = s.teamScores!;
    expect(tp[0] + tp[1]).toBe(100 + 50 * (s.sweeps[0] + s.sweeps[1]));
    expect(e.calculateScore()[N]).toBe(tp[0]);
    expect(e.calculateScore()[E]).toBe(tp[1]);
    expect(e.isGameFinished()).toBe(true);
    const batchEvents = s.events.filter((ev) => ev.type === 'BATCH_DEALT');
    expect(batchEvents).toHaveLength(3);
  });

  it('plays a scripted small deal: sweep, then leftovers go to the last capturer', () => {
    // 8-card deck: 4 hands of 1 + table [2♠, 9♠].
    const hands = {
      [N]: [c('n1', 'diamonds', 4)],
      [E]: [c('e1', 'diamonds', 5)],
      [S]: [c('s1', 'diamonds', 6)],
      [W]: [c('w1', 'diamonds', 7)],
    };
    const table = [c('t1', 'spades', 2), c('t2', 'spades', 9)];
    const e = tinyDeal(hands, table);
    // n lays 4 (4 unreachable from {2,9}); e lays 5 (5 unreachable).
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'LAY_DOWN' } }).ok).toBe(true);
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: E, cardId: 'e1', intent: { kind: 'LAY_DOWN' } }).ok).toBe(true);
    // s captures 2+4 with 6 → table holds 9♠ and east's laid 5♦ → no sweep.
    let res = e.handleAction({ type: 'PLAY_CARD', playerId: S, cardId: 's1', intent: { kind: 'CAPTURE', tableCardIds: ['t1', 'n1'] } });
    expect(res.ok).toBe(true);
    let s = e.getState();
    expect(s.tableLoose.map((x) => x.id)).toEqual(['t2', 'e1']);
    expect(s.lastCaptureTeam).toBe(0);
    // w lays 7; deal ends: leftovers (9♠ + laid 5♦ + laid 7♦) go to team 0.
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: W, cardId: 'w1', intent: { kind: 'LAY_DOWN' } }).ok).toBe(true);
    s = e.getState();
    expect(s.phase).toBe('ROUND_COMPLETE');
    expect(s.captures[N]!.map((x) => x.id)).toEqual(['t2', 'e1', 'w1']);
    // Team 0: 9♠ (9, north) + 2♠ (2, in south's captures) = 11. Team 1: 0.
    expect(s.captures[S]!.map((x) => x.id)).toEqual(['s1', 't1', 'n1']);
    expect(s.teamScores).toEqual({ 0: 11, 1: 0 });
    expect(s.roundWinnerTeam).toBe(0);
    // Partners share the team score.
    expect(e.calculateScore()[S]).toBe(11);
  });

  it('finishes cleanly regardless of who captures in a tiny deal', () => {
    const hands = {
      [N]: [c('n1', 'diamonds', 13)],
      [E]: [c('e1', 'diamonds', 12)],
      [S]: [c('s1', 'diamonds', 11)],
      [W]: [c('w1', 'diamonds', 1)],
    };
    const table = [c('t1', 'spades', 2), c('t2', 'spades', 3), c('t3', 'spades', 4), c('t4', 'spades', 5)];
    const e = tinyDeal(hands, table);
    let guard = 0;
    while (!e.isGameFinished() && guard++ < 16) {
      const res = e.handleAction(bestAction(e, e.getState().players[e.getState().currentTurn]!.id));
      expect(res.ok).toBe(true);
    }
    const s = e.getState();
    expect(s.phase).toBe('ROUND_COMPLETE');
    // Score = captured card points + sweep bonuses (tiny deck ⇒ tiny total).
    const capturedPoints = ORDER
      .flatMap((pid) => s.captures[pid]!)
      .reduce((sum, card) => sum + cardPoints(card, e.getRules()), 0);
    expect(s.teamScores![0] + s.teamScores![1]).toBe(capturedPoints + 50 * (s.sweeps[0] + s.sweeps[1]));
  });

  it('blocks plays after the deal is over', () => {
    const hands = {
      [N]: [c('n1', 'diamonds', 4)],
      [E]: [c('e1', 'diamonds', 5)],
      [S]: [c('s1', 'diamonds', 6)],
      [W]: [c('w1', 'diamonds', 7)],
    };
    const table = [c('t1', 'spades', 2), c('t2', 'spades', 9)];
    const e = tinyDeal(hands, table);
    e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'LAY_DOWN' } });
    e.handleAction({ type: 'PLAY_CARD', playerId: E, cardId: 'e1', intent: { kind: 'LAY_DOWN' } });
    e.handleAction({ type: 'PLAY_CARD', playerId: S, cardId: 's1', intent: { kind: 'CAPTURE', tableCardIds: ['t1', 'n1'] } });
    e.handleAction({ type: 'PLAY_CARD', playerId: W, cardId: 'w1', intent: { kind: 'LAY_DOWN' } });
    expect(e.getState().phase).toBe('ROUND_COMPLETE');
    expect(
      e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 't1', intent: { kind: 'LAY_DOWN' } }).error,
    ).toMatch(/over/);
  });
});

describe('filtered views', () => {
  it('shows a viewer their own hand plus all face-up zones only', () => {
    const e = viewDeal();
    const v = e.getPlayerState(N);
    expect(v.gameId).toBe('seep');
    expect(v.myTeam).toBe(0);
    expect(v.teams[0]).toEqual([N, S]);
    expect(v.teams[1]).toEqual([E, W]);
    // Own hand visible (n1 was played; the fillers remain).
    const myRemaining = (v.handCardIds[N] ?? [])[0]!;
    expect(Object.keys(v.knownCards)).toContain(myRemaining);
    // Face-up zones visible.
    expect(v.tableLoose.map((x) => x.id)).toEqual(['t1', 't4', 'e1']);
    expect(v.captures[N]!.map((x) => x.id)).toEqual(['n1', 't2', 't3']);
    // Opponent hand values hidden, ids present.
    expect(v.handCardIds[E]).toHaveLength(3);
    for (const id of v.handCardIds[E]) expect(v.knownCards[id]).toBeUndefined();
    expect(v.handCounts[E]).toBe(3);
    // West's spade queen is NOT visible to north (never on the table).
    expect(v.knownCards['w1']).toBeUndefined();
    // Current turn flag lives on the base view.
    expect(v.players.find((p) => p.isCurrentTurn)?.id).toBe(S);
    expect(v.discardTop).toBeNull();
  });

  it('exposes live team points and sweeps', () => {
    const e = viewDeal();
    const v = e.getPlayerState(N);
    // n captured 5♦ (0) + 2♥ (0) + 3♣ (0) — zeros; nothing on the scoreboard yet.
    expect(v.teamPoints).toEqual({ 0: 0, 1: 0 });
    expect(v.sweeps).toEqual({ 0: 0, 1: 0 });
    expect(v.roundResult).toBeNull();
  });

  it('revealAll (Test Mode) exposes opponent hands and the deck', () => {
    // A full seeded deal keeps 32 cards in the deck to check against.
    const e = fresh({ seed: 5 });
    const westFirst = e.getState().hands[W]![0]!;
    const deckCard = e.getState().deck[0]!;
    const vNormal = e.getPlayerState(N);
    expect(vNormal.knownCards[westFirst.id]).toBeUndefined();
    expect(vNormal.knownCards[deckCard.id]).toBeUndefined();
    const v = e.getPlayerState(N, { revealAll: true });
    expect(v.knownCards[westFirst.id]).toBeDefined();
    expect(v.knownCards[deckCard.id]).toBeDefined();
  });

  it('reports the round result at ROUND_COMPLETE', () => {
    const hands = {
      [N]: [c('n1', 'diamonds', 4)],
      [E]: [c('e1', 'diamonds', 5)],
      [S]: [c('s1', 'diamonds', 6)],
      [W]: [c('w1', 'diamonds', 7)],
    };
    const table = [c('t1', 'spades', 2), c('t2', 'spades', 9)];
    const e = tinyDeal(hands, table);
    e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'LAY_DOWN' } });
    e.handleAction({ type: 'PLAY_CARD', playerId: E, cardId: 'e1', intent: { kind: 'LAY_DOWN' } });
    e.handleAction({ type: 'PLAY_CARD', playerId: S, cardId: 's1', intent: { kind: 'CAPTURE', tableCardIds: ['t1', 'n1'] } });
    e.handleAction({ type: 'PLAY_CARD', playerId: W, cardId: 'w1', intent: { kind: 'LAY_DOWN' } });
    const v = e.getPlayerState(E);
    expect(v.roundResult).toEqual({
      winnerTeam: 0,
      tiedTeams: [],
      teamScores: { 0: 11, 1: 0 },
    });
  });
});

describe('restore', () => {
  it('round-trips a mid-deal state exactly', () => {
    const e = viewDeal();
    const snapshot = structuredClone(e.getState());
    const e2 = new SeepEngine();
    e2.restoreState(structuredClone(snapshot));
    expect(JSON.stringify(e2.getState())).toEqual(JSON.stringify(snapshot));
    // And it keeps playing identically.
    const s = e.getState();
    const pid = s.players[s.currentTurn]!.id;
    const action = bestAction(e2, pid);
    const before = e2.getState().revision;
    expect(e2.handleAction(action).ok).toBe(true);
    expect(e2.getState().revision).toBeGreaterThan(before);
  });

  it('rejects unsupported state versions', () => {
    const e = new SeepEngine();
    expect(() => e.restoreState({ ...structuredClone(viewDeal().getState()), stateVersion: 2 as never })).toThrow(/version/);
  });
});

describe('sweep bonus flows into the score', () => {
  it('credits the sweep bonus to the sweeping team', () => {
    const hands = {
      [N]: [c('n1', 'diamonds', 9)],
      [E]: [c('e1', 'diamonds', 5)],
      [S]: [c('s1', 'diamonds', 6)],
      [W]: [c('w1', 'diamonds', 7)],
    };
    const table = [c('t1', 'spades', 9)];
    const e = tinyDeal(hands, table);
    // n captures 9♠ with 9♦ → table empty → SEEP! (+50) and 9 points.
    const res = e.handleAction({ type: 'PLAY_CARD', playerId: N, cardId: 'n1', intent: { kind: 'CAPTURE', tableCardIds: ['t1'] } });
    expect(res.ok).toBe(true);
    // rest of the plays
    e.handleAction({ type: 'PLAY_CARD', playerId: E, cardId: 'e1', intent: { kind: 'LAY_DOWN' } });
    e.handleAction({ type: 'PLAY_CARD', playerId: S, cardId: 's1', intent: { kind: 'LAY_DOWN' } });
    e.handleAction({ type: 'PLAY_CARD', playerId: W, cardId: 'w1', intent: { kind: 'LAY_DOWN' } });
    const s = e.getState();
    expect(s.sweeps[0]).toBe(1);
    expect(s.teamScores).toEqual({ 0: 59, 1: 0 });
  });
});
