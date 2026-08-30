/**
 * Seep engine tests — canonical Punjabi 100-point rules.
 * Contract: docs/rules/seep-punjabi-100.md (Pagat).
 *
 * Fixtures use forced decks laid out in the real counter-clockwise deal
 * order: bidder's 4, floor 4, then counter-clockwise packets of four from
 * the bidder until every hand holds 12 (bidder 11 after his first play —
 * 4 + 4 + 8 + 36 = 52 exactly).
 *
 * Fixture conventions to keep decks valid:
 *  - bidder cards are hearts, floor cards spades/diamonds, extras clubs —
 *    so suit+rank signatures never collide;
 *  - floors avoid loose sets that sum to the house total (they would
 *    auto-cement — the engine is right, the fixtures would lie);
 *  - walks through filler turns use `walkOnce`, which never touches the
 *    house under test.
 */
import { describe, expect, it } from 'vitest';
import type { Card, Suit } from '@game-night/shared';
import {
  DEFAULT_SEEP_RULES,
  SeepEngine,
  cardPoints,
  enumerateSeepActions,
  houseCopies,
  houseIsPakka,
  maximalCaptureAlternatives,
  totalDeckPoints,
  type SeepAction,
  type SeepPlayerView,
  type SeepState,
} from '../src/index.js';

const c = (id: string, suit: Suit, rank: number): Card => ({ id, suit, rank });
const PLAYERS = ['n', 'e', 's', 'w'].map((id, i) => ({ id, name: id.toUpperCase(), seat: i }));
let tagSeq = 0;

/** Signature-safe filler; never collides with the pool or reserved extras. */
function filler(n: number, pool: Card[], reserved: Set<string> = new Set()): Card[] {
  const taken = new Set([...pool.map((x) => `${x.suit}${x.rank}`), ...reserved]);
  const out: Card[] = [];
  for (const suit of ['clubs', 'diamonds', 'hearts', 'spades'] as Suit[]) {
    for (let rank = 1; rank <= 13 && out.length < n; rank++) {
      if (taken.has(`${suit}${rank}`)) continue;
      taken.add(`${suit}${rank}`);
      const card = c(`f${tagSeq++}`, suit, rank);
      out.push(card);
      pool.push(card);
    }
  }
  if (out.length < n) throw new Error(`filler exhausted: need ${n - out.length} more`);
  return out;
}

/** Forced deck (reversed so pop() deals in exactly the written order). */
function zoneDeck(pool: Card[]): Card[] {
  return [...pool].reverse();
}

/** Counter-clockwise packets from the bidder until every hand reaches 12. */
function completeDeal(pool: Card[], extras: Partial<Record<'w' | 's' | 'e' | 'n', Card[]>> = {}): void {
  // reserve every extra signature so early fillers cannot steal it
  const reserved = new Set(Object.values(extras).flat().map((x) => `${x.suit}${x.rank}`));
  const counts: Record<string, number> = { w: 4, s: 0, e: 0, n: 0 };
  const packets: Record<string, number> = { w: 0, s: 0, e: 0, n: 0 };
  while (Object.values(counts).some((n) => n < 12)) {
    for (const pid of ['w', 's', 'e', 'n'] as const) {
      if (counts[pid] >= 12) continue;
      const extra = packets[pid] === 0 ? extras[pid] : undefined;
      if (extra) {
        for (const card of extra) {
          if (pool.some((x) => x.suit === card.suit && x.rank === card.rank)) {
            throw new Error(`fixture collision: ${card.suit}${card.rank}`);
          }
        }
        pool.push(...extra);
        filler(4 - extra.length, pool, reserved);
      } else {
        filler(4, pool, reserved);
      }
      counts[pid] += 4;
      packets[pid] += 1;
    }
  }
}

function newEngine(pool: Card[], opts: { dealerSeat?: number; rules?: Record<string, number> } = {}): SeepEngine {
  const e = new SeepEngine();
  e.createGame(PLAYERS, {
    forcedDeck: zoneDeck(pool),
    dealerSeat: opts.dealerSeat ?? 0,
    rules: opts.rules as never,
  });
  return e;
}

const state = (e: SeepEngine): SeepState => e.getState();
const view = (e: SeepEngine, pid: string): SeepPlayerView => e.getPlayerState(pid);
const pidAt = (e: SeepEngine, seat: number): string => state(e).players[seat]!.id;

function announce(e: SeepEngine, value: number): void {
  const bidder = pidAt(e, state(e).bidderSeat);
  const res = e.handleAction({ type: 'ANNOUNCE', playerId: bidder, value } as never);
  expect(res.ok, `announce ${value}: ${res.error ?? ''}`).toBe(true);
}

function play(e: SeepEngine, pid: string, cardId: string, intent: unknown): { ok: boolean; error?: string } {
  return e.handleAction({ type: 'PLAY_CARD', playerId: pid, cardId, intent } as never);
}

function acts(e: SeepEngine, pid: string): SeepAction[] {
  return enumerateSeepActions(view(e, pid), pid);
}

/** Soundness gate: everything enumerated must be engine-legal. */
function expectEnumeratedLegal(e: SeepEngine, pid: string): SeepAction[] {
  const list = acts(e, pid);
  for (const a of list) {
    expect(
      e.validateAction(a as never),
      `enumerated action must validate: ${JSON.stringify((a as { intent?: unknown }).intent ?? a.type)}`,
    ).toBe(true);
  }
  return list;
}

/** Bidder builds a kachcha 9-house from 6+3, keeping the backing 9. */
function houseTable(): SeepEngine {
  const pool: Card[] = [
    c('w6', 'hearts', 6), c('w9', 'hearts', 9), c('w3', 'diamonds', 3), c('w2', 'hearts', 2), // bidder
    c('t3', 'spades', 3), c('t2', 'spades', 2), c('tK', 'diamonds', 13), c('tQ', 'diamonds', 12), // floor: no 9-sums
  ];
  completeDeal(pool);
  const e = newEngine(pool);
  announce(e, 9);
  expect(play(e, 'w', 'w6', { kind: 'BUILD', tableCardIds: ['t3'], total: 9 }).ok).toBe(true);
  return e;
}

/**
 * One filler turn for `pid` that never mutates the house layout: no break,
 * add, build, or house capture (plain lays and loose captures only).
 */
function walkOnce(e: SeepEngine, pid: string, houseId: string | null): void {
  const all = expectEnumeratedLegal(e, pid);
  const safe = all.filter((a) => {
    if (a.type !== 'PLAY_CARD') return false;
    const it = a.intent;
    if (it.kind === 'BREAK_HOUSE' || it.kind === 'ADD_TO_HOUSE' || it.kind === 'BUILD') return false;
    if (it.kind === 'CAPTURE') return it.houseIds.length === 0;
    return it.kind === 'LAY_DOWN';
  });
  const list = safe.length > 0 ? safe : all;
  expect(list.length, `no walk action for ${pid}`).toBeGreaterThan(0);
  const res = e.handleAction(list[0]! as never);
  expect(res.ok, `walk failed: ${JSON.stringify(list[0])}`).toBe(true);
}

// ---------------------------------------------------------------------------

describe('deck and capture alternatives', () => {
  it('scores exactly 100 points: spades face value, aces 1, 10♦ 6', () => {
    expect(totalDeckPoints(DEFAULT_SEEP_RULES)).toBe(100);
    const d = (suit: Suit, rank: number) => cardPoints(c('x', suit, rank), DEFAULT_SEEP_RULES);
    expect(d('spades', 13)).toBe(13);
    expect(d('spades', 1)).toBe(1);
    expect(d('hearts', 1)).toBe(1);
    expect(d('diamonds', 10)).toBe(6);
    expect(d('clubs', 10)).toBe(0);
    expect(d('hearts', 5)).toBe(0);
  });

  it('a J over floor 2,3,5,6 has exactly the two overlapping maximal alternatives', () => {
    const alts = maximalCaptureAlternatives(
      [c('a', 'clubs', 2), c('b', 'clubs', 3), c('d', 'clubs', 5), c('e', 'clubs', 6)],
      11,
    );
    expect(alts).toHaveLength(2);
    const sizes = alts.map((g) => g.map((x) => x.length).sort().join('+')).sort();
    expect(sizes).toEqual(['2', '3']);
  });

  it('an 8 over A,3,5,7,8 has exactly one maximal alternative (take everything)', () => {
    const alts = maximalCaptureAlternatives(
      [c('a', 'clubs', 1), c('b', 'clubs', 3), c('d', 'clubs', 5), c('e', 'clubs', 7), c('f', 'clubs', 8)],
      8,
    );
    expect(alts).toHaveLength(1);
    expect(alts[0]!.reduce((n, g) => n + g.length, 0)).toBe(5);
  });
});

describe('opening: deal, bid and first play', () => {
  it('deals 4 to the bidder + 4 face-down floor cards; the full deal uses all 52 cards', () => {
    const pool: Card[] = [c('b1', 'hearts', 11)];
    filler(3, pool); // rest of bidder hand
    filler(4, pool); // floor
    completeDeal(pool);
    const e = newEngine(pool);
    const s = state(e);
    expect(s.phase).toBe('ANNOUNCE');
    expect(s.bidderSeat).toBe(3); // to the dealer's right (counter-clockwise)
    expect(s.currentTurn).toBe(3);
    expect(view(e, 'w').tableLoose).toHaveLength(0);
    expect(view(e, 'w').tableFaceDownCount).toBe(4);
    announce(e, 11);
    expect(view(e, 'w').tableLoose).toHaveLength(4);
    const driver = legalDriver();
    while ((state(e).phase === 'TURN_PLAY' || state(e).phase === 'ANNOUNCE') && driver(e)) { /* play the deal out */ }
    const s2 = state(e);
    expect(s2.deck).toHaveLength(0);
    expect(Object.values(s2.hands).flat()).toHaveLength(0);
    expect(Object.values(s2.captures).flat()).toHaveLength(52);
    expect(s2.phase === 'DEAL_COMPLETE' || s2.phase === 'MATCH_COMPLETE').toBe(true);
  });

  it('the first play must involve the bid; Pagat 7-8-8-J must take 2+9+J', () => {
    const pool: Card[] = [
      c('j', 'hearts', 11), c('h7', 'hearts', 7), c('h8a', 'hearts', 8), c('h8b', 'diamonds', 8), // bidder
      c('f2', 'spades', 2), c('f9', 'spades', 9), c('fj', 'clubs', 11), c('fk', 'diamonds', 13), // floor
    ];
    completeDeal(pool);
    const e = newEngine(pool);
    announce(e, 11);

    // throwing a non-bid card or capturing partially is illegal
    expect(play(e, 'w', 'h7', { kind: 'LAY_DOWN' }).ok).toBe(false);
    expect(play(e, 'w', 'j', { kind: 'CAPTURE', tableCardIds: ['f2', 'f9'], houseIds: [] }).ok).toBe(false);
    // the J MUST take 2+9 and the loose J — the K (13) stays
    expect(play(e, 'w', 'j', { kind: 'CAPTURE', tableCardIds: ['f2', 'f9', 'fj'], houseIds: [] }).ok).toBe(true);
    const s = state(e);
    expect(s.tableLoose.map((x) => x.id)).toEqual(['fk']);
    expect(s.captures['w']).toHaveLength(4);
    expect(s.playsMade).toBe(1);
    expectEnumeratedLegal(e, 'w');
  });

  it('a first-play sweep of the floor pays only 25', () => {
    const pool: Card[] = [
      c('q', 'hearts', 12), c('b2', 'hearts', 3), c('b3', 'diamonds', 5), c('b4', 'diamonds', 4), // bidder
      c('f1', 'spades', 4), c('f2', 'spades', 4), c('f3', 'clubs', 12), c('f4', 'hearts', 4), // floor
    ];
    completeDeal(pool);
    const e = newEngine(pool);
    announce(e, 12);
    // Q takes {f3} and {f1,f2,f4} (4+4+4=12) — all four floor cards → sweep
    const res = play(e, 'w', 'q', { kind: 'CAPTURE', tableCardIds: ['f1', 'f2', 'f3', 'f4'], houseIds: [] });
    expect(res.ok, res.error).toBe(true);
    const s = state(e);
    expect(s.sweeps[1]).toBe(1); // w is seat 3 → team 1
    expect(s.sweepPoints[1]).toBe(25);
  });
});

describe('must-capture is per played card, not per hand', () => {
  function mustTable(): SeepEngine {
    // bidder throws the J (no 11-group on the floor); s then holds 8 + J backing
    const pool: Card[] = [
      c('wJ', 'hearts', 11), c('w2', 'hearts', 2), c('w4', 'hearts', 4), c('w5', 'diamonds', 5), // bidder
      c('t3', 'spades', 3), c('t5', 'spades', 5), c('t2', 'diamonds', 2), c('tK', 'diamonds', 13), // floor: single 8-group {3,5}
    ];
    completeDeal(pool, {
      s: [c('s8', 'clubs', 8), c('sJb', 'clubs', 11), c('s6', 'clubs', 6), c('s9', 'clubs', 9)],
    });
    const e = newEngine(pool);
    announce(e, 11);
    // opening play: throw the bid card (it takes nothing: floor has no 11-group)
    expect(play(e, 'w', 'wJ', { kind: 'LAY_DOWN' }).ok).toBe(true);
    expect(pidAt(e, state(e).currentTurn)).toBe('s');
    return e;
  }

  it('a card that can capture may not be thrown and capture-all is enforced', () => {
    const e = mustTable();
    expect(play(e, 's', 's8', { kind: 'LAY_DOWN' }).ok).toBe(false);
    expect(play(e, 's', 's8', { kind: 'CAPTURE', tableCardIds: ['t3'], houseIds: [] }).ok).toBe(false);
    expect(play(e, 's', 's8', { kind: 'CAPTURE', tableCardIds: ['t3', 't5'], houseIds: [] }).ok).toBe(true);
  });

  it('BUILD is a legal alternative use even when the card could capture', () => {
    const e = mustTable();
    // 8+3=11 build (backed by sJb) instead of capturing 3+5 — the loose wJ
    // auto-cements the house (a loose card of the same value joins it)
    const res = play(e, 's', 's8', { kind: 'BUILD', tableCardIds: ['t3'], total: 11 });
    expect(res.ok, res.error).toBe(true);
    const h = state(e).houses[0]!;
    expect(h.total).toBe(11);
    expect(houseIsPakka(h)).toBe(true); // wJ was auto-absorbed
    expectEnumeratedLegal(e, 's');
  });
});

describe('houses: build, retention, break, cement', () => {
  it('builds a kachcha ghar; pakka is derived from copies, not stored', () => {
    const e = houseTable();
    const h = state(e).houses[0]!;
    expect(h.total).toBe(9);
    expect(h.cards.map((x) => x.id).sort()).toEqual(['t3', 'w6'].sort());
    expect(houseCopies(h)).toBe(1);
    expect(houseIsPakka(h)).toBe(false);
    expect(h.ownerByTeam[1]).toBe('w'); // w is seat 3 → team 1
    expect(state(e).houses.filter((x) => x.total === 9)).toHaveLength(1);
  });

  it('a build that does not form complete copies of the total is rejected', () => {
    const pool: Card[] = [
      c('w6', 'hearts', 6), c('w9', 'hearts', 9), c('w3', 'diamonds', 3), c('w2', 'hearts', 2),
      c('t3', 'spades', 3), c('t2', 'spades', 2), c('tK', 'diamonds', 13), c('tQ', 'diamonds', 12),
    ];
    completeDeal(pool);
    const e = newEngine(pool);
    announce(e, 9);
    // 6+3 = 9 is a complete copy; declaring total 10 is nonsense
    expect(play(e, 'w', 'w6', { kind: 'BUILD', tableCardIds: ['t3'], total: 10 }).ok).toBe(false);
  });

  it('a single play can establish a cemented house (9 played onto a loose 9)', () => {
    const pool: Card[] = [
      c('w9a', 'hearts', 9), c('w9b', 'hearts', 9), c('w9c', 'diamonds', 9), c('w2', 'hearts', 2), // bidder: three 9s
      c('t9', 'spades', 9), c('t5', 'spades', 5), c('tK', 'diamonds', 13), c('tQ', 'diamonds', 12), // floor: loose 9
    ];
    completeDeal(pool);
    const e = newEngine(pool);
    announce(e, 9);
    // play one 9 onto the loose 9 → 18 = 2 copies → pakka, backed by w9b
    const res = play(e, 'w', 'w9a', { kind: 'BUILD', tableCardIds: ['t9'], total: 9 });
    expect(res.ok, res.error).toBe(true);
    const h = state(e).houses[0]!;
    expect(h.total).toBe(9);
    expect(houseCopies(h)).toBe(2);
    expect(houseIsPakka(h)).toBe(true);
    expect(h.ownerByTeam[1]).toBe('w');
  });

  it('a kachcha ghar can be broken by a non-owner; the breaker becomes owner with retention', () => {
    const pool: Card[] = [
      c('w6', 'hearts', 6), c('w9', 'hearts', 9), c('w3', 'diamonds', 3), c('w2', 'hearts', 2), // bidder
      c('t3', 'spades', 3), c('t2', 'spades', 2), c('tK', 'diamonds', 13), c('tQ', 'diamonds', 12), // floor
    ];
    completeDeal(pool, {
      s: [c('s2', 'clubs', 2), c('sJ', 'clubs', 11), c('sJb', 'diamonds', 11), c('s4', 'clubs', 4)], // break 9→11, backing J
    });
    const e = newEngine(pool);
    announce(e, 9);
    expect(play(e, 'w', 'w6', { kind: 'BUILD', tableCardIds: ['t3'], total: 9 }).ok).toBe(true);
    expect(pidAt(e, state(e).currentTurn)).toBe('s'); // counter-clockwise: w → s
    const houseId = state(e).houses[0]!.id;
    const res = play(e, 's', 's2', { kind: 'BREAK_HOUSE', houseId });
    expect(res.ok, res.error).toBe(true);
    const h = state(e).houses[0]!;
    expect(h.total).toBe(11);
    expect(h.ownerByTeam[0]).toBe('s'); // s is seat 2 → team 0: the breaker took over
    expect(state(e).hands['s']!.some((x) => x.rank === 11)).toBe(true); // retention
  });

  it('breaking your own ghar is illegal; a cemented ghar cannot be broken', () => {
    // w holds TWO 9s: cementing his own ghar needs one 9 to play and one to keep
    const pool: Card[] = [
      c('w6', 'hearts', 6), c('w9a', 'hearts', 9), c('w9b', 'diamonds', 9), c('w3', 'hearts', 3), // bidder
      c('t3', 'spades', 3), c('t2', 'spades', 2), c('tK', 'diamonds', 13), c('tQ', 'diamonds', 12), // floor
    ];
    completeDeal(pool);
    const e = newEngine(pool);
    announce(e, 9);
    expect(play(e, 'w', 'w6', { kind: 'BUILD', tableCardIds: ['t3'], total: 9 }).ok).toBe(true);
    const houseId = state(e).houses[0]!.id;
    for (const pid of ['s', 'e', 'n']) walkOnce(e, pid, houseId);
    expect(pidAt(e, state(e).currentTurn)).toBe('w');
    // w owns it → cannot break it himself
    expect(play(e, 'w', 'w9a', { kind: 'BREAK_HOUSE', houseId }).ok).toBe(false);
    // owner cements with one 9 while keeping the second
    const res = play(e, 'w', 'w9a', { kind: 'ADD_TO_HOUSE', houseId, tableCardIds: [] });
    expect(res.ok, res.error).toBe(true);
    expect(houseIsPakka(state(e).houses[0]!)).toBe(true);
    // pakka → any break now fails
    expect(play(e, 'w', 'w3', { kind: 'BREAK_HOUSE', houseId }).ok).toBe(false);
  });

  it('an opponent cementing becomes co-owner of one pakka ghar (both teams retain)', () => {
    const pool: Card[] = [
      c('w6', 'hearts', 6), c('w9', 'hearts', 9), c('w3', 'diamonds', 3), c('w2', 'hearts', 2), // bidder
      c('t3', 'spades', 3), c('t2', 'spades', 2), c('tK', 'diamonds', 13), c('tQ', 'diamonds', 12), // floor
    ];
    completeDeal(pool, {
      n: [c('n9', 'spades', 9), c('n9b', 'clubs', 9), c('n4', 'spades', 4), c('n5', 'hearts', 5)], // cement + retention
    });
    const e = newEngine(pool);
    announce(e, 9);
    expect(play(e, 'w', 'w6', { kind: 'BUILD', tableCardIds: ['t3'], total: 9 }).ok).toBe(true);
    const houseId = state(e).houses[0]!.id;
    for (const pid of ['s', 'e']) walkOnce(e, pid, houseId);
    expect(pidAt(e, state(e).currentTurn)).toBe('n');
    const res = play(e, 'n', 'n9', { kind: 'ADD_TO_HOUSE', houseId, tableCardIds: [] });
    expect(res.ok, res.error).toBe(true);
    const h = state(e).houses[0]!;
    expect(houseCopies(h)).toBe(2);
    expect(houseIsPakka(h)).toBe(true);
    expect(h.ownerByTeam[1]).toBe('w');
    expect(h.ownerByTeam[0]).toBe('n'); // second owner via cement
    expect(state(e).hands['n']!.some((x) => x.rank === 9)).toBe(true); // both retain
    expect(state(e).hands['w']!.some((x) => x.rank === 9)).toBe(true);
  });
});

describe('auto-cement', () => {
  it('building a 12-house while a loose Q lies on the floor absorbs it (pakka)', () => {
    const pool: Card[] = [
      c('w5', 'hearts', 5), c('wq', 'hearts', 12), c('w4', 'hearts', 4), c('w3', 'diamonds', 3), // bidder: 5+4+3=12, backing Q
      c('t4', 'spades', 4), c('t3', 'spades', 3), c('tq', 'diamonds', 12), c('t2', 'spades', 2), // floor: loose Q
    ];
    completeDeal(pool);
    const e = newEngine(pool);
    announce(e, 12);
    const res = play(e, 'w', 'w5', { kind: 'BUILD', tableCardIds: ['t4', 't3'], total: 12 });
    expect(res.ok, res.error).toBe(true);
    const h = state(e).houses[0]!;
    expect(h.cards.map((x) => x.id).sort()).toEqual(['w5', 't4', 't3', 'tq'].sort());
    expect(houseIsPakka(h)).toBe(true);
    expect(state(e).tableLoose.some((x) => x.id === 'tq')).toBe(false);
  });

  it('breaking into a total matching a loose set cements automatically (9+1=10 over 4+6)', () => {
    const pool: Card[] = [
      c('w6', 'hearts', 6), c('w9', 'hearts', 9), c('w3', 'diamonds', 3), c('w2', 'hearts', 2), // bidder: build 9 (6+t3), backing 9
      c('t3', 'spades', 3), c('t4', 'diamonds', 4), c('t6', 'diamonds', 6), c('t2', 'spades', 2), // floor: 4+6=10 loose
    ];
    completeDeal(pool, {
      s: [c('s1', 'clubs', 1), c('s10b', 'clubs', 10), c('s8', 'clubs', 8), c('s5', 'clubs', 5)], // break 9+1=10, backing 10
    });
    const e = newEngine(pool);
    announce(e, 9);
    expect(play(e, 'w', 'w6', { kind: 'BUILD', tableCardIds: ['t3'], total: 9 }).ok).toBe(true);
    // no auto-cement at build time: nothing on the floor equals/sums to 9
    expect(houseIsPakka(state(e).houses[0]!)).toBe(false);
    expect(pidAt(e, state(e).currentTurn)).toBe('s');
    const houseId = state(e).houses[0]!.id;
    const res = play(e, 's', 's1', { kind: 'BREAK_HOUSE', houseId });
    expect(res.ok, res.error).toBe(true);
    const h = state(e).houses[0]!;
    expect(h.total).toBe(10);
    expect(h.cards.map((x) => x.id).sort()).toEqual(['w6', 't3', 's1', 't4', 't6'].sort());
    expect(houseCopies(h)).toBe(2); // 6+3+1+4+6 = 20 = 2 × 10
    expect(houseIsPakka(h)).toBe(true);
    expect(state(e).hands['s']!.some((x) => x.rank === 10)).toBe(true); // breaker retains
  });
});

describe('capturing houses and leftovers', () => {
  it('a J takes a J-house and a loose 7+4 in the same compulsory play', () => {
    const pool: Card[] = [
      c('wj', 'hearts', 11), c('wb', 'hearts', 2), c('wc', 'diamonds', 3), c('wd', 'diamonds', 5), // bidder
      c('fj', 'spades', 11), c('f7', 'spades', 7), c('f4', 'diamonds', 4), c('fx', 'hearts', 4), // floor: J + 7+4
    ];
    completeDeal(pool);
    const e = newEngine(pool);
    announce(e, 11);
    const res = play(e, 'w', 'wj', { kind: 'CAPTURE', tableCardIds: ['f7', 'f4', 'fj'], houseIds: [] });
    expect(res.ok, res.error).toBe(true);
    expect(state(e).captures['w']).toHaveLength(4);
  });

  it('a ghar is captured by its matching card alone (never as part of a set)', () => {
    const e = houseTable();
    const houseId = state(e).houses[0]!.id;
    for (const pid of ['s', 'e', 'n']) walkOnce(e, pid, houseId);
    expect(pidAt(e, state(e).currentTurn)).toBe('w');
    const res = play(e, 'w', 'w9', { kind: 'CAPTURE', tableCardIds: [], houseIds: [houseId] });
    expect(res.ok, res.error).toBe(true);
    expect(state(e).houses).toHaveLength(0);
    expect(state(e).captures['w']).toHaveLength(3); // w9 + house cards
  });

  it('a queen cannot pick up a 9-house together with a 3 (house needs the exact card)', () => {
    const pool: Card[] = [
      c('w6', 'hearts', 6), c('w9', 'hearts', 9), c('w3', 'diamonds', 3), c('w2', 'hearts', 2), // bidder
      c('t3', 'spades', 3), c('t2', 'spades', 2), c('tK', 'diamonds', 13), c('tQ', 'diamonds', 12), // floor
    ];
    completeDeal(pool, {
      s: [c('sQ', 'clubs', 12), c('sQb', 'hearts', 12), c('s7', 'clubs', 7), c('s8', 'clubs', 8)],
    });
    const e = newEngine(pool);
    announce(e, 9);
    expect(play(e, 'w', 'w6', { kind: 'BUILD', tableCardIds: ['t3'], total: 9 }).ok).toBe(true);
    const houseId = state(e).houses[0]!.id;
    // floor has no group of 12, so a Q could only target the house — and 12 ≠ 9
    expect(play(e, 's', 'sQ', { kind: 'CAPTURE', tableCardIds: [], houseIds: [houseId] }).ok).toBe(false);
    expectEnumeratedLegal(e, 's');
  });

  it('leftover floor cards go to the team that picked up last', () => {
    const e = new SeepEngine();
    e.createGame(PLAYERS, { seed: 777 });
    const driver = legalDriver();
    while ((state(e).phase === 'TURN_PLAY' || state(e).phase === 'ANNOUNCE') && driver(e)) { /* play */ }
    const s = state(e);
    expect(s.tableLoose).toHaveLength(0);
    expect(s.houses).toHaveLength(0);
    const piles = Object.values(s.captures).flat();
    expect(piles).toHaveLength(52);
    const pts = piles.reduce((sum, card) => sum + cardPoints(card, DEFAULT_SEEP_RULES), 0);
    const scores = s.teamScores!;
    expect(scores[0] + scores[1]).toBe(pts + s.sweepPoints[0] + s.sweepPoints[1]);
  });
});

describe('sweep timing', () => {
  it('mid-deal sweep pays 50; the final-card sweep scores nothing', () => {
    const rules = DEFAULT_SEEP_RULES;
    expect(rules.sweepBonus).toBe(50);
    expect(rules.firstPlaySweepBonus).toBe(25);
    expect(rules.lastPlaySweepZero).toBe(true);
    for (let seed = 5; seed <= 7; seed++) {
      const e = new SeepEngine();
      e.createGame(PLAYERS, { seed: seed * 991 });
      const driver = legalDriver();
      let plays = 0;
      let ok = true;
      while ((state(e).phase === 'TURN_PLAY' || state(e).phase === 'ANNOUNCE') && ok) {
        const before = state(e).sweepPoints[0] + state(e).sweepPoints[1];
        ok = driver(e);
        const after = state(e);
        plays = after.playsMade;
        if (after.sweepPoints[0] + after.sweepPoints[1] > before && plays >= 48) {
          throw new Error('sweep awarded on the final play');
        }
      }
      expect(plays).toBe(48);
    }
  });
});

describe('baazi match play', () => {
  it('accumulates deal differences, applies the minimum-loss rule and rotates the dealer', () => {
    const e = new SeepEngine();
    e.createGame(PLAYERS, { seed: 20240, rules: { minimumDealPoints: 40, baaziLeadTarget: 45 } as never });
    let guard = 0;
    while (state(e).phase !== 'MATCH_COMPLETE' && guard++ < 30) {
      const driver = legalDriver();
      while ((state(e).phase === 'TURN_PLAY' || state(e).phase === 'ANNOUNCE') && driver(e)) { /* play the deal */ }
      if (state(e).phase === 'MATCH_COMPLETE') break;
      const s = state(e);
      expect(s.dealHistory.length).toBeGreaterThan(0);
      const last = s.dealHistory[s.dealHistory.length - 1]!;
      const dealerTeam = s.dealerSeat % 2;
      const dealerAhead = last.leadAfter === 0 ? null : last.leadAfter > 0 ? 0 : 1;
      const expected = dealerAhead !== dealerTeam ? s.dealerSeat : (s.dealerSeat + 3) % 4;
      const baaziJustEnded = !!last.baazi;
      e.handleNextDeal(s.players[s.dealerSeat]!.id);
      const s2 = state(e);
      if (baaziJustEnded) {
        // after a baazi the partner of the would-be next dealer deals
        expect(s2.dealerSeat).toBe((expected + 2) % 4);
      } else {
        expect(s2.dealerSeat).toBe(expected);
      }
      expect(s2.dealNo).toBe(s.dealNo + 1);
      expect(s2.tableLoose).toHaveLength(0);
      expect(s2.houses).toHaveLength(0);
      expect(s2.bid).toBeNull();
    }
    expect(state(e).phase).toBe('MATCH_COMPLETE');
    expect(state(e).baazisWon[0] + state(e).baazisWon[1]).toBeGreaterThanOrEqual(1);
    // scoreboard = baazis won, shared by each partnership
    const score = e.calculateScore();
    for (const p of PLAYERS) {
      expect(score[p.id]).toBe(state(e).baazisWon[p.seat % 2]);
    }
  });

  it('a deal below the minimum instantly loses the baazi', () => {
    const e = new SeepEngine();
    e.createGame(PLAYERS, { seed: 9001, rules: { minimumDealPoints: 500 } as never });
    const driver = legalDriver();
    while ((state(e).phase === 'TURN_PLAY' || state(e).phase === 'ANNOUNCE') && driver(e)) { /* one deal */ }
    const s = state(e);
    // 500 is unreachable → BOTH teams below the minimum → the lower scorer loses
    expect(s.phase).toBe('MATCH_COMPLETE');
    const winner = s.teamScores![0] < s.teamScores![1] ? 1 : 0;
    expect(s.baaziWinnerTeam).toBe(winner);
    expect(s.baaziReason).toBe('minimum-points');
    expect(s.baaziLead).toBe(0);
  });
});

describe('information model', () => {
  it('captured cards are inspectable only until the next player plays', () => {
    const pool: Card[] = [
      c('w9', 'hearts', 9), c('w9b', 'hearts', 9), c('w3', 'diamonds', 3), c('w6', 'hearts', 6), // bidder
      c('t3', 'spades', 3), c('t6', 'diamonds', 6), c('t2', 'spades', 2), c('tK', 'diamonds', 13), // floor: single 9-group {3,6}
    ];
    completeDeal(pool);
    const e = newEngine(pool);
    announce(e, 9);
    expect(play(e, 'w', 'w9', { kind: 'CAPTURE', tableCardIds: ['t3', 't6'], houseIds: [] }).ok).toBe(true);
    // next player (s) has not played yet → the pick-up is still inspectable
    const v0 = view(e, 'n');
    expect([...v0.inspectableCardIds].sort()).toEqual(['t3', 't6', 'w9'].sort());
    expect(v0.knownCards['t3']).toBeDefined();
    // after s plays, the window closes for everyone
    walkOnce(e, 's', null);
    const v1 = view(e, 'n');
    expect(v1.knownCards['t3']).toBeUndefined();
    expect(v1.knownCards['w9']).toBeUndefined();
    expect(v1.inspectableCardIds).toHaveLength(0);
    // pile sizes stay public, contents do not
    expect(v1.captureCounts['w']).toBe(3);
    // hands of other players stay hidden
    expect(v1.handCardIds['e']!.every((id) => v1.knownCards[id] === undefined)).toBe(true);
  });

  it('houses remain fully inspectable at all times', () => {
    const e = houseTable();
    const v = view(e, 'n');
    expect(v.houses).toHaveLength(1);
    expect(v.houses[0]!.cards.every((card) => !!v.knownCards[card.id])).toBe(true);
    expect(v.houses[0]!.ownerByTeam).toEqual({ 1: 'w' });
  });
});

describe('enumeration soundness under fuzz', () => {
  it('every enumerated action validates across random playouts', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const e = new SeepEngine();
      e.createGame(PLAYERS, { seed: seed * 1013 });
      let guard = 0;
      while (state(e).phase === 'TURN_PLAY' && guard++ < 60) {
        const pid = pidAt(e, state(e).currentTurn);
        const list = expectEnumeratedLegal(e, pid);
        if (list.length === 0) break;
        const pick = list[guard % list.length]!;
        expect(e.handleAction(pick as never).ok, `action failed: ${JSON.stringify(pick)}`).toBe(true);
      }
      const s = state(e);
      const inPlay =
        Object.values(s.hands).flat().length +
        Object.values(s.captures).flat().length +
        s.tableLoose.length +
        s.houses.reduce((n, h) => n + h.cards.length, 0) +
        s.deck.length;
      expect(inPlay).toBe(52);
    }
  });
});

// ---------------------------------------------------------------------------

function rank(a: SeepAction): number {
  if (a.type !== 'PLAY_CARD') return 0;
  const it = a.intent;
  if (it.kind === 'CAPTURE') return 100 + it.tableCardIds.length + it.houseIds.length * 5;
  if (it.kind === 'ADD_TO_HOUSE') return 60;
  if (it.kind === 'BUILD') return 50;
  if (it.kind === 'BREAK_HOUSE') return 40;
  return 10;
}

/** Greedy driver that only ever plays enumerated (validated) actions. */
function legalDriver(): (e: SeepEngine) => boolean {
  return (e: SeepEngine): boolean => {
    const s = state(e);
    if (s.phase === 'ANNOUNCE') {
      const bidder = pidAt(e, s.bidderSeat);
      const options = acts(e, bidder).filter((a) => a.type === 'ANNOUNCE');
      if (options.length === 0) return false;
      const best = options.sort((a, b) => (b as { value: number }).value - (a as { value: number }).value)[0]!;
      expect(e.handleAction(best as never).ok).toBe(true);
      return true;
    }
    if (s.phase !== 'TURN_PLAY') return false;
    const pid = pidAt(e, s.currentTurn);
    const list = expectEnumeratedLegal(e, pid);
    if (list.length === 0) return false;
    list.sort((a, b) => rank(b) - rank(a));
    const res = e.handleAction(list[0]! as never);
    expect(res.ok, `driver action failed: ${JSON.stringify(list[0])}`).toBe(true);
    return true;
  };
}
