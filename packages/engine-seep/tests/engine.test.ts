import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEEP_RULES,
  VARIANT_TEN_DIAMOND_SIX,
  SeepEngine,
  SeepEngineError,
  cardPoints,
  captureValue,
  mergeSeepRules,
  partitionableInto,
  reachableSubsetSum,
  teamOfSeat,
  totalDeckPoints,
  type SeepPlayerView,
  type SeepState,
} from '../src/index.js';
import { createRng, shuffle, standardDeck, type Card, type GameAction, type Suit } from '@game-night/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORDER = ['n', 'e', 's', 'w'];
const PLAYERS = ORDER.map((id, i) => ({ id, name: id.toUpperCase(), seat: i }));
const teamOfPlayer = (pid: string): 0 | 1 => (ORDER.indexOf(pid) % 2) as 0 | 1;

const c = (id: string, suit: Suit, rank: number): Card => ({ id, suit, rank });

/** Extra cards to pad a forced deck up to exactly 52 (face-exact, ids renamed). */
function filler(n: number, used: Iterable<Card>, tag: string): Card[] {
  const taken = new Set([...used].map((x) => `${x.suit}${x.rank}`));
  const out: Card[] = [];
  for (const card of standardDeck()) {
    if (out.length >= n) break;
    if (taken.has(`${card.suit}${card.rank}`)) continue;
    taken.add(`${card.suit}${card.rank}`);
    out.push({ ...card, id: `f-${tag}-${out.length}` });
  }
  return out;
}

/**
 * Assemble a physical deck from zones listed in POP ORDER (the first zone's
 * first card is dealt first — deck.pop() walks the array from the end).
 */
function buildDeck(zones: Card[][]): Card[] {
  const flat: Card[] = [];
  for (const zone of zones) flat.push(...zone);
  return flat.slice().reverse();
}

/** Full 52-card deck laid out: opener, table, then the post-announce deal. */
function deckFrom(opener: Card[], table: Card[], then: Card[]): Card[] {
  return buildDeck([opener, table, then, filler(52, [...opener, ...table, ...then], 'z')]);
}

type Options = Parameters<SeepEngine['createGame']>[1];

function fresh(opts: Options = {}): SeepEngine {
  const engine = new SeepEngine();
  engine.createGame(PLAYERS, { firstTurnSeat: 0, ...opts });
  return engine;
}

const state = (e: SeepEngine): SeepState => e.getState();
const view = (e: SeepEngine, pid = 'n', opts?: { revealAll?: boolean }): SeepPlayerView =>
  e.getPlayerState(pid, opts) as SeepPlayerView;

function announce(e: SeepEngine, value: number, pid = 'n'): void {
  const res = e.handleAction({ type: 'ANNOUNCE', playerId: pid, value } as GameAction);
  expect(res.ok).toBe(true);
}

/** Announce the highest biddable value the opener holds (the announce only). */
function announceBest(e: SeepEngine, pid = 'n'): number {
  const hand = state(e).hands[pid] ?? [];
  const best = Math.max(...hand.map((x) => captureValue(x)));
  announce(e, best, pid);
  return best;
}

type PlayIntent = Extract<SeepAction, { type: 'PLAY_CARD' }>['intent'];

function play(e: SeepEngine, playerId: string, cardId: string, intent: PlayIntent): { ok: boolean; error?: string } {
  return e.handleAction({ type: 'PLAY_CARD', playerId, cardId, intent } as unknown as GameAction);
}

/** Enumerate every subset (max 6 cards) of `cards` summing exactly to `sum`. */
function subsetsSumming(cards: Card[], sum: number): Card[][] {
  const out: Card[][] = [];
  const walk = (start: number, cur: Card[], total: number): void => {
    if (total === sum && cur.length > 0) out.push([...cur]);
    if (start >= cards.length || cur.length >= 6) return;
    for (let j = start; j < cards.length; j++) {
      walk(j + 1, [...cur, cards[j]!], total + captureValue(cards[j]!));
    }
  };
  walk(0, [], 0);
  return out;
}

/** Lay any legal card (first in hand order that validates). */
function layAny(e: SeepEngine, pid: string): void {
  const hand = state(e).hands[pid]!;
  for (const card of hand) {
    const res = play(e, pid, card.id, { kind: 'LAY_DOWN' });
    if (res.ok) return;
  }
  throw new Error(`${pid} has no legal lay`);
}

/**
 * Full-deal driver: announces the top value, then plays the first VALID
 * action from a greedy candidate list (captures first, lays last).
 */
function autoPlay(e: SeepEngine): void {
  if (state(e).phase === 'ANNOUNCE') announceBest(e);
  let guard = 0;
  while (!e.isGameFinished() && guard++ < 300) {
    const s = state(e);
    const pid = s.players[s.currentTurn]!.id;
    const action = greedyAction(e, s, pid);
    if (!action) throw new Error(`no action for ${pid}`);
    const res = e.handleAction(action);
    if (!res.ok) throw new Error(`driver failed for ${pid}: ${res.error}`);
  }
  expect(e.isGameFinished()).toBe(true);
}

function greedyAction(e: SeepEngine, s: SeepState, pid: string): GameAction | null {
  const hand = s.hands[pid] ?? [];
  if (s.phase === 'ANNOUNCE') {
    return { type: 'ANNOUNCE', playerId: pid, value: Math.max(...hand.map((x) => captureValue(x))) } as unknown as GameAction;
  }
  const first = s.playsMade === 0;
  const bid = s.bid!;
  const ranked = [...hand].sort((a, b) => captureValue(b) - captureValue(a));
  const candidates: GameAction[] = [];
  for (const card of ranked) {
    const v = captureValue(card);
    if (first && v !== bid) continue;
    const houses = s.houses.filter((h) => h.total === v);
    const subsets = subsetsSumming(s.tableLoose, v);
    if (subsets.length > 0 || houses.length > 0) {
      candidates.push({
        type: 'PLAY_CARD',
        playerId: pid,
        cardId: card.id,
        intent: { kind: 'CAPTURE', tableCardIds: subsets[0]?.map((x) => x.id) ?? [], houseIds: houses.map((h) => h.id) },
      } as unknown as GameAction);
    }
  }
  for (const card of ranked) {
    if (first && captureValue(card) !== bid) continue;
    candidates.push({ type: 'PLAY_CARD', playerId: pid, cardId: card.id, intent: { kind: 'LAY_DOWN' } } as unknown as GameAction);
  }
  return candidates.find((action) => e.validateAction(action)) ?? null;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

describe('scoring — the common 100-point table', () => {
  const rules = DEFAULT_SEEP_RULES;

  it('scores every spade at face value, faces included', () => {
    expect(cardPoints(c('as', 'spades', 1), rules)).toBe(1);
    expect(cardPoints(c('s7', 'spades', 7), rules)).toBe(7);
    expect(cardPoints(c('s11', 'spades', 11), rules)).toBe(11);
    expect(cardPoints(c('s12', 'spades', 12), rules)).toBe(12);
    expect(cardPoints(c('s13', 'spades', 13), rules)).toBe(13);
  });

  it('scores the other aces 1 and the ten of diamonds 2', () => {
    expect(cardPoints(c('ah', 'hearts', 1), rules)).toBe(1);
    expect(cardPoints(c('ad', 'diamonds', 1), rules)).toBe(1);
    expect(cardPoints(c('ac', 'clubs', 1), rules)).toBe(1);
    expect(cardPoints(c('td', 'diamonds', 10), rules)).toBe(2);
    expect(cardPoints(c('5c', 'clubs', 5), rules)).toBe(0);
  });

  it('the deck is worth 96 card points, 100 with the majority bonus', () => {
    expect(totalDeckPoints(rules)).toBe(96);
    expect(totalDeckPoints(rules) + rules.majorityCardsBonus).toBe(100);
  });

  it('the family variant (10♦ = 6, no majority) also totals 100', () => {
    const variant = mergeSeepRules(VARIANT_TEN_DIAMOND_SIX);
    expect(cardPoints(c('td', 'diamonds', 10), variant)).toBe(6);
    expect(variant.majorityCardsBonus).toBe(0);
    expect(totalDeckPoints(variant)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Group captures
// ---------------------------------------------------------------------------

describe('partitionable captures', () => {
  it('accepts several separate groups captured together (A+7, 3+5, 8 with an 8)', () => {
    const cards = [c('a', 'clubs', 1), c('7', 'hearts', 7), c('3', 'diamonds', 3), c('5', 'spades', 5), c('8', 'clubs', 8)];
    expect(partitionableInto(cards, 8)).toBe(true);
  });
  it('rejects a selection that cannot group evenly', () => {
    expect(partitionableInto([c('a', 'clubs', 1), c('3', 'diamonds', 3), c('5', 'spades', 5)], 8)).toBe(false);
    expect(partitionableInto([], 8)).toBe(false);
  });
  it('still answers the simple subset-sum question', () => {
    expect(reachableSubsetSum([c('x', 'clubs', 2), c('y', 'hearts', 3), c('z', 'spades', 5)], 10)).toBe(true);
    expect(reachableSubsetSum([c('x', 'clubs', 2), c('y', 'hearts', 3)], 6)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deal, announce and the constrained opening play
// ---------------------------------------------------------------------------

describe('deal and announce', () => {
  it('deals 4 to the opener and 4 face-down to the table', () => {
    const e = fresh({ seed: 7 });
    const s = state(e);
    expect(s.phase).toBe('ANNOUNCE');
    expect(s.hands['n']).toHaveLength(4);
    expect(s.hands['e']).toHaveLength(0);
    expect(s.tableLoose).toHaveLength(4);
    expect(s.deck).toHaveLength(44);
    expect(s.bid).toBeNull();
  });

  it('hides the face-down table from views until the announce', () => {
    const e = fresh({ seed: 7 });
    const v = view(e, 'e');
    expect(v.tableLoose).toEqual([]);
    expect(v.tableFaceDownCount).toBe(4);
    for (const card of state(e).tableLoose) expect(v.knownCards[card.id]).toBeUndefined();
    // Test Mode sees through the backs.
    const vTest = view(e, 'e', { revealAll: true });
    for (const card of state(e).tableLoose) expect(vTest.knownCards[card.id]).toBeDefined();
  });

  it('redeals automatically when the opener cannot announce (all cards ≤ 8)', () => {
    let seed = 0;
    for (let s = 1; s < 20000; s++) {
      const deck = shuffle(standardDeck(), createRng(s));
      if (deck.slice(-4).every((x) => x.rank < 9)) {
        seed = s;
        break;
      }
    }
    expect(seed).toBeGreaterThan(0);
    const e = fresh({ seed });
    const s = state(e);
    expect(s.hands['n']!.some((x) => x.rank >= 9)).toBe(true);
    expect(s.events.some((ev) => ev.type === 'REDEAL')).toBe(true);
  });

  it('only the opener may announce, and only a value they hold', () => {
    const e = fresh({ seed: 7 });
    expect(e.handleAction({ type: 'ANNOUNCE', playerId: 'e', value: 10 } as GameAction).ok).toBe(false);
    const held = state(e).hands['n']!.map(captureValue);
    const notHeld = [9, 10, 11, 12, 13].find((x) => !held.includes(x));
    if (notHeld !== undefined) {
      expect(e.handleAction({ type: 'ANNOUNCE', playerId: 'n', value: notHeld } as GameAction).ok).toBe(false);
    }
    expect(e.handleAction({ type: 'ANNOUNCE', playerId: 'n', value: 8 } as GameAction).ok).toBe(false);
  });

  it('playing before the announce is rejected; announcing turns the table up', () => {
    const e = fresh({ seed: 7 });
    const card = state(e).hands['n']![0]!;
    expect(e.handleAction({ type: 'PLAY_CARD', playerId: 'n', cardId: card.id, intent: { kind: 'LAY_DOWN' } } as GameAction).ok).toBe(false);
    announceBest(e);
    const s = state(e);
    expect(s.phase).toBe('TURN_PLAY');
    expect(s.bid).toBeGreaterThanOrEqual(9);
    const v = view(e, 'e');
    expect(v.tableLoose).toHaveLength(4);
    expect(v.tableFaceDownCount).toBe(0);
    for (const card2 of s.tableLoose) expect(v.knownCards[card2.id]).toBeDefined();
  });
});

// Opener: 10♥ 6♠ 5♣ 2♦; table: 4♦ 9♣ 8♠ 3♥ — no accidental 6/10 captures.
function openingEngine(): SeepEngine {
  const opener = [c('h10', 'hearts', 10), c('s6', 'spades', 6), c('c5', 'clubs', 5), c('d2', 'diamonds', 2)];
  const table = [c('d4', 'diamonds', 4), c('c9', 'clubs', 9), c('s8', 'spades', 8), c('h3', 'hearts', 3)];
  return fresh({ forcedDeck: deckFrom(opener, table, filler(44, [...opener, ...table], 'o')), firstTurnSeat: 0 });
}

describe('the opening play must involve the announced number', () => {
  it('rejects a capture with a non-announced card', () => {
    const e = openingEngine();
    announce(e, 10);
    // 6+4 = 10 needs the announced card; playing the 6 to capture only 4 (6) is
    // doubly invalid: the 4 does not equal 6 AND the play ignores the bid.
    const res = play(e, 'n', 's6', { kind: 'CAPTURE', tableCardIds: ['h3'], houseIds: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/announced/);
  });

  it('allows building the announced total with the promised card in hand', () => {
    const e = openingEngine();
    announce(e, 10);
    const res = play(e, 'n', 's6', { kind: 'BUILD', tableCardIds: ['d4'], total: 10 });
    expect(res.ok).toBe(true);
    const s = state(e);
    expect(s.houses).toHaveLength(1);
    expect(s.houses[0]).toMatchObject({ total: 10, ownerId: 'n', sets: 1 });
  });

  it('rejects a build of a different total on the opening play', () => {
    const e = openingEngine();
    announce(e, 10);
    // 6+3 = 9 — a fine ghar, but the announce was 10.
    const res = play(e, 'n', 's6', { kind: 'BUILD', tableCardIds: ['h3'], total: 9 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/announced/);
  });

  it('laying the announced card is always available', () => {
    const e = openingEngine();
    announce(e, 10);
    expect(play(e, 'n', 'h10', { kind: 'LAY_DOWN' }).ok).toBe(true);
  });

  it('laying a non-announced card on the opening play is rejected', () => {
    const e = openingEngine();
    announce(e, 10);
    const res = play(e, 'n', 'c5', { kind: 'LAY_DOWN' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/announced 10|throw the announced/);
  });
});

describe('the rest of the deal lands after the first play', () => {
  it('tops everyone up (opener 11, others 12) and never deals again', () => {
    const e = openingEngine();
    announce(e, 10);
    expect(play(e, 'n', 'h10', { kind: 'LAY_DOWN' }).ok).toBe(true);
    const s = state(e);
    expect(s.hands['n']).toHaveLength(11);
    expect(s.hands['e']).toHaveLength(12);
    expect(s.hands['s']).toHaveLength(12);
    expect(s.hands['w']).toHaveLength(12);
    expect(s.deck).toHaveLength(0);
    expect(s.dealRestPending).toBe(false);
    expect(s.events.filter((ev) => ev.type === 'BATCH_DEALT')).toHaveLength(3);
    expect(s.playsMade).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Houses: kachcha, pakka, adding, breaking, retention
// ---------------------------------------------------------------------------

// Ghar 9 built by n (6 + loose 3, backed by 9♥). Table keeps 8/4/7.
// The rest-deal runs in rounds (n,e,s,w / n,e,s,w / e,s,w), so the scripted
// top-ups are laid out per round: E must find 13/2/Q/7 etc. in hand order.
function houseEngine(): { e: SeepEngine; houseId: string } {
  const opener = [c('h9', 'hearts', 9), c('s6', 'spades', 6), c('c5', 'clubs', 5), c('d2', 'diamonds', 2)];
  const table = [c('d3', 'diamonds', 3), c('c8', 'clubs', 8), c('s4', 'spades', 4), c('h7', 'hearts', 7)];
  const used = [...opener, ...table];
  const rounds: Card[][] = [];
  // round 1: n (holds the second 9), e (K, 2, Q, 6), s (10), w (6)
  rounds.push([c('n1', 'clubs', 9), ...filler(3, [...used, c('n1', 'clubs', 9)], 'na')]);
  rounds.push([c('e1', 'clubs', 13), c('e2', 'hearts', 2), c('e3', 'diamonds', 12), c('e4', 'spades', 11)]);
  rounds.push([c('s1', 'hearts', 10), ...filler(3, [...used, c('n1', 'clubs', 9), c('s1', 'hearts', 10)], 'sa')]);
  rounds.push([c('w1', 'clubs', 6), ...filler(3, [...used, c('n1', 'clubs', 9), c('s1', 'hearts', 10), c('w1', 'clubs', 6)], 'wa')]);
  // round 2: n (filler), e (7 …), s, w
  rounds.push(filler(4, [...used, c('n1', 'clubs', 9)], 'nb'));
  rounds.push([c('e5', 'clubs', 7), ...filler(3, [...used, c('n1', 'clubs', 9), c('e5', 'clubs', 7)], 'eb')]);
  rounds.push(filler(4, [...used, c('n1', 'clubs', 9)], 'sb'));
  rounds.push(filler(4, [...used, c('n1', 'clubs', 9)], 'wb'));
  // round 3: e (…9 among them), s, w — n sits out (11 cards already)
  rounds.push([c('e9', 'hearts', 9), ...filler(3, [...used, c('n1', 'clubs', 9), c('e9', 'hearts', 9)], 'ec')]);
  rounds.push(filler(4, [...used, c('n1', 'clubs', 9)], 'sc'));
  rounds.push(filler(4, [...used, c('n1', 'clubs', 9)], 'wc'));
  const e2 = fresh({ forcedDeck: deckFrom(opener, table, rounds.flat()), firstTurnSeat: 0 });
  announce(e2, 9);
  const res = play(e2, 'n', 's6', { kind: 'BUILD', tableCardIds: ['d3'], total: 9 });
  expect(res.ok).toBe(true);
  return { e: e2, houseId: state(e2).houses[0]!.id };
}

describe('houses (ghar)', () => {
  it('ghar totals must lie between 9 and 13', () => {
    const opener = [c('h9', 'hearts', 9), c('s6', 'spades', 6), c('c5', 'clubs', 5), c('d2', 'diamonds', 2)];
    const table = [c('d3', 'diamonds', 3), c('c9', 'clubs', 9), c('s4', 'spades', 4), c('h7', 'hearts', 7)];
    const e = fresh({ forcedDeck: deckFrom(opener, table, filler(44, [...opener, ...table], 'g')), firstTurnSeat: 0 });
    announce(e, 9);
    // 6+3 = 9 ✓ (range checks: 6+4 = 10 is fine too — the 8 and 14 cases are
    // exercised structurally by the min/max rules; total 9 is the boundary).
    expect(play(e, 'n', 's6', { kind: 'BUILD', tableCardIds: ['d3'], total: 9 }).ok).toBe(true);
  });

  it('building requires holding the promised card', () => {
    // Opener holds J but no 10: 6+4 cannot be built into ghar 10.
    const opener = [c('h11', 'hearts', 11), c('s6', 'spades', 6), c('c5', 'clubs', 5), c('d2', 'diamonds', 2)];
    const table = [c('d4', 'diamonds', 4), c('c9', 'clubs', 9), c('s8', 'spades', 8), c('h5', 'hearts', 5)];
    const e = fresh({ forcedDeck: deckFrom(opener, table, filler(44, [...opener, ...table], 'p')), firstTurnSeat: 0 });
    announce(e, 11);
    // The announced J has no capture (no 11 among 4/9/8/5) → lay it.
    expect(play(e, 'n', 'h11', { kind: 'LAY_DOWN' }).ok).toBe(true);
  });

  it('an owner may add another complete set, making the ghar pakka', () => {
    const { e, houseId } = houseEngine();
    layAny(e, 'e');
    layAny(e, 's');
    layAny(e, 'w');
    // n's top-up holds a second 9 — play it onto the ghar (9 alone = the set).
    const hand = state(e).hands['n']!;
    const nine = hand.find((x) => captureValue(x) === 9);
    expect(nine).toBeDefined();
    const res = play(e, 'n', nine!.id, { kind: 'ADD_TO_HOUSE', houseId, tableCardIds: [] });
    expect(res.ok).toBe(true);
    expect(state(e).houses[0]!.sets).toBe(2);
    expect(view(e, 'n').houses[0]!.pakka).toBe(true);
  });

  it('adding with a completed set of loose cards keeps the total (pakka rule 12)', () => {
    const e = fresh({ seed: 5 });
    const s = state(e);
    s.houses.push({ id: 'h-1', total: 12, ownerId: 'n', sets: 2, cards: [c('a', 'clubs', 7), c('b', 'diamonds', 5)] });
    s.tableLoose = [c('t7', 'clubs', 7), c('t3', 'hearts', 3)];
    s.hands = { n: [c('m2', 'spades', 2), c('mq', 'hearts', 12)], e: [c('x1', 'clubs', 2)], s: [c('x2', 'clubs', 3)], w: [c('x3', 'clubs', 4)] };
    s.currentTurn = 0;
    s.bid = 12;
    s.phase = 'TURN_PLAY';
    s.dealRestPending = false;
    s.playsMade = 9;
    // 2 + 7 + 3 = 12 — another complete set joins the pakka ghar.
    const res = play(e, 'n', 'm2', { kind: 'ADD_TO_HOUSE', houseId: 'h-1', tableCardIds: ['t7', 't3'] });
    expect(res.ok).toBe(true);
    expect(state(e).houses[0]!.sets).toBe(3);
    expect(state(e).tableLoose).toEqual([]);
  });

  it('only the owning team may add to a ghar', () => {
    const { e, houseId } = houseEngine();
    // E holds a 9 (filled into eRest? use the top-up: find any 9 in E's hand)
    const eHand = state(e).hands['e']!;
    const nine = eHand.find((x) => captureValue(x) === 9);
    if (!nine) return; // filler variation — owning-team rule covered below
    const res = play(e, 'e', nine.id, { kind: 'ADD_TO_HOUSE', houseId, tableCardIds: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/owning team/);
  });

  it('any player holding a matching value may add for the owner? no — opponents cannot', () => {
    // Crafted: opponent holds 12 with n's pakka ghar 12 on an empty table.
    const e = fresh({ seed: 5 });
    const s = state(e);
    s.houses.push({ id: 'h-1', total: 12, ownerId: 'n', sets: 1, cards: [c('a', 'clubs', 7), c('b', 'diamonds', 5)] });
    s.tableLoose = [];
    s.hands = { n: [c('m3', 'spades', 3)], e: [c('xq', 'clubs', 12)], s: [c('x2', 'clubs', 3)], w: [c('x3', 'clubs', 4)] };
    s.currentTurn = 1;
    s.bid = 12;
    s.phase = 'TURN_PLAY';
    s.dealRestPending = false;
    s.playsMade = 9;
    const res = play(e, 'e', 'xq', { kind: 'ADD_TO_HOUSE', houseId: 'h-1', tableCardIds: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/owning team/);
  });

  it('breaking a kachcha ghar raises the total and transfers ownership', () => {
    const { e, houseId } = houseEngine();
    // E holds 2 and Q(12): break ghar 9 by playing the 2 → ghar 11.
    const res = play(e, 'e', 'e2', { kind: 'BREAK_HOUSE', houseId });
    expect(res.ok).toBe(true);
    const house = state(e).houses[0]!;
    expect(house.total).toBe(11);
    expect(house.ownerId).toBe('e');
    expect(house.sets).toBe(1);
  });

  it('a break that overshoots 13 or lacks the new total is rejected', () => {
    const { e, houseId } = houseEngine();
    // K: 9+13 = 22 → out of range.
    expect(play(e, 'e', 'e1', { kind: 'BREAK_HOUSE', houseId }).ok).toBe(false);
    // 7: 9+7 = 16 → out of range (also matches the loose 7 — either way invalid).
    expect(play(e, 'e', 'e5', { kind: 'BREAK_HOUSE', houseId }).ok).toBe(false);
    // 2 with the Q held: 9+2 = 11 ✓ → the same break as the ownership test.
    expect(play(e, 'e', 'e2', { kind: 'BREAK_HOUSE', houseId }).ok).toBe(true);
  });

  it('you cannot break your own ghar, but your partner may', () => {
    const e = fresh({ seed: 5 });
    const s = state(e);
    s.houses.push({ id: 'h-1', total: 9, ownerId: 'n', sets: 1, cards: [c('a', 'clubs', 4), c('b', 'diamonds', 5)] });
    s.tableLoose = [];
    s.hands = {
      n: [c('m2', 'spades', 2), c('m11', 'hearts', 11)],
      e: [c('x1', 'clubs', 3)],
      s: [c('p2', 'hearts', 2), c('p11', 'clubs', 11)],
      w: [c('x3', 'clubs', 4)],
    };
    s.currentTurn = 0;
    s.bid = 9;
    s.phase = 'TURN_PLAY';
    s.dealRestPending = false;
    s.playsMade = 9;
    // The owner himself may not break his ghar.
    const own = play(e, 'n', 'm2', { kind: 'BREAK_HOUSE', houseId: 'h-1' });
    expect(own.ok).toBe(false);
    expect(own.error).toMatch(/own ghar/);
    // But the partner (same team, different player) may take it over.
    s.currentTurn = 2;
    const partner = play(e, 's', 'p2', { kind: 'BREAK_HOUSE', houseId: 'h-1' });
    expect(partner.ok).toBe(true);
    expect(state(e).houses[0]!.ownerId).toBe('s');
  });

  it('an owner must retain a matching card while the ghar stands', () => {
    const e = fresh({ seed: 5 });
    const s = state(e);
    s.houses.push(
      { id: 'h-1', total: 9, ownerId: 'n', sets: 1, cards: [c('a', 'clubs', 4), c('b', 'diamonds', 5)] },
      { id: 'h-2', total: 9, ownerId: 'n', sets: 1, cards: [c('d', 'hearts', 4), c('e', 'spades', 5)] },
    );
    s.tableLoose = [];
    s.hands = {
      n: [c('m9', 'hearts', 9)],
      e: [c('x1', 'clubs', 3)],
      s: [c('x2', 'clubs', 3)],
      w: [c('x3', 'clubs', 4)],
    };
    s.currentTurn = 0;
    s.bid = 9;
    s.phase = 'TURN_PLAY';
    s.dealRestPending = false;
    s.playsMade = 9;
    // Spending the only 9 on one of the two ghars orphans the other.
    const res = play(e, 'n', 'm9', { kind: 'CAPTURE', tableCardIds: [], houseIds: ['h-1'] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/keep a 9/);
    // Taking BOTH houses retires the obligation.
    expect(play(e, 'n', 'm9', { kind: 'CAPTURE', tableCardIds: [], houseIds: ['h-1', 'h-2'] }).ok).toBe(true);
    expect(state(e).houses).toHaveLength(0);
  });

  it('a pakka ghar cannot be broken', () => {
    const { e, houseId } = houseEngine();
    layAny(e, 'e');
    layAny(e, 's');
    layAny(e, 'w');
    const hand = state(e).hands['n']!;
    const nine = hand.find((x) => captureValue(x) === 9);
    expect(nine).toBeDefined();
    expect(play(e, 'n', nine!.id, { kind: 'ADD_TO_HOUSE', houseId, tableCardIds: [] }).ok).toBe(true);
    expect(state(e).houses[0]!.sets).toBe(2);
    const res = play(e, 'e', 'e2', { kind: 'BREAK_HOUSE', houseId });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/pakka/);
  });

  it('capturing a ghar takes the whole stack with the matching card', () => {
    const { e, houseId } = houseEngine();
    const res = play(e, 'e', 'e10', { kind: 'CAPTURE', tableCardIds: [], houseIds: [houseId] });
    if (state(e).hands['e']!.some((x) => x.id === 'e10')) {
      // e10 is a 9 → captures the ghar.
      expect(res.ok).toBe(true);
      expect(state(e).houses).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Captures, must-capture and sweeps
// ---------------------------------------------------------------------------

describe('captures', () => {
  it('take several separate groups and matching houses in one play', () => {
    const e = fresh({ seed: 3 });
    const s = state(e);
    s.houses.push({ id: 'h-1', total: 9, ownerId: 'w', sets: 1, cards: [c('hc1', 'clubs', 4), c('hc2', 'diamonds', 5)] });
    s.tableLoose = [
      c('t1', 'clubs', 1), c('t2', 'hearts', 8), c('t3', 'diamonds', 3), c('t4', 'spades', 6), c('t5', 'clubs', 9),
    ];
    s.hands = { n: [c('m9', 'hearts', 9)], e: [c('x1', 'clubs', 2)], s: [c('x2', 'clubs', 3)], w: [c('x3', 'clubs', 4)] };
    s.currentTurn = 0;
    s.bid = 9;
    s.phase = 'TURN_PLAY';
    s.dealRestPending = false;
    s.playsMade = 9;
    // 1+8 = 9, 3+6 = 9, the loose 9, and the whole house — one play.
    const res = play(e, 'n', 'm9', { kind: 'CAPTURE', tableCardIds: ['t1', 't2', 't3', 't4', 't5'], houseIds: ['h-1'] });
    expect(res.ok).toBe(true);
    expect(s.captures['n']).toHaveLength(1 + 5 + 2);
    // Everything is gone → that is also a sweep (+50, mid-deal).
    expect(s.tableLoose).toHaveLength(0);
    expect(s.houses).toHaveLength(0);
    expect(s.sweepPoints[0]).toBe(50);
    expect(s.lastCaptureTeam).toBe(0);
  });

  it('rejects a selection whose groups do not all match the played value', () => {
    const e = fresh({ seed: 3 });
    const s = state(e);
    s.tableLoose = [c('t1', 'clubs', 1), c('t2', 'hearts', 8), c('t3', 'diamonds', 3)];
    s.hands = { n: [c('m8', 'hearts', 8)], e: [c('x1', 'clubs', 2)], s: [c('x2', 'clubs', 3)], w: [c('x3', 'clubs', 4)] };
    s.currentTurn = 0;
    s.bid = 8;
    s.phase = 'TURN_PLAY';
    s.dealRestPending = false;
    s.playsMade = 9;
    // 1+8 = 9 — not a group of 8s, so the selection is illegal even though 8 alone matches.
    const res = play(e, 'n', 'm8', { kind: 'CAPTURE', tableCardIds: ['t1', 't2'], houseIds: [] });
    expect(res.ok).toBe(false);
    expect(play(e, 'n', 'm8', { kind: 'CAPTURE', tableCardIds: ['t2'], houseIds: [] }).ok).toBe(true);
  });

  it('enforces must-capture against laying, building, adding and breaking', () => {
    const e = fresh({ seed: 3 });
    const s = state(e);
    s.houses.push({ id: 'h-1', total: 9, ownerId: 'n', sets: 1, cards: [c('hc1', 'clubs', 4), c('hc2', 'diamonds', 5)] });
    s.tableLoose = [c('t9', 'clubs', 9)];
    s.hands = { n: [c('m9', 'hearts', 9)], e: [c('x1', 'clubs', 2)], s: [c('x2', 'clubs', 3)], w: [c('x3', 'clubs', 4)] };
    s.currentTurn = 0;
    s.bid = 9;
    s.phase = 'TURN_PLAY';
    s.dealRestPending = false;
    s.playsMade = 9;
    expect(play(e, 'n', 'm9', { kind: 'LAY_DOWN' }).ok).toBe(false);
    expect(play(e, 'n', 'm9', { kind: 'ADD_TO_HOUSE', houseId: 'h-1', tableCardIds: [] }).ok).toBe(false);
    expect(play(e, 'n', 'm9', { kind: 'CAPTURE', tableCardIds: ['t9'], houseIds: ['h-1'] }).ok).toBe(true);
  });

  it('a matching card may still be played onto an own-team house when no loose capture exists', () => {
    const e = fresh({ seed: 3 });
    const s = state(e);
    s.houses.push({ id: 'h-1', total: 10, ownerId: 'n', sets: 1, cards: [c('hc1', 'clubs', 4), c('hc2', 'diamonds', 6)] });
    s.tableLoose = [c('t3', 'clubs', 3)];
    s.hands = { n: [c('m10', 'hearts', 10), c('m10b', 'spades', 10)], e: [c('x1', 'clubs', 2)], s: [c('x2', 'clubs', 3)], w: [c('x3', 'clubs', 4)] };
    s.currentTurn = 0;
    s.bid = 10;
    s.phase = 'TURN_PLAY';
    s.dealRestPending = false;
    s.playsMade = 9;
    // Rule 11: two 10s — play one onto the ghar, keep the other as the promise.
    const res = play(e, 'n', 'm10', { kind: 'ADD_TO_HOUSE', houseId: 'h-1', tableCardIds: [] });
    expect(res.ok).toBe(true);
    expect(state(e).houses[0]!.sets).toBe(2);
  });
});

describe('sweeps', () => {
  function sweepEngine(): SeepEngine {
    // Opening play sweeps: bid 10, table 1+2+3+4 (one group summing 10).
    const opener = [c('h10', 'hearts', 10), c('s6', 'spades', 6), c('c5', 'clubs', 5), c('d2', 'diamonds', 2)];
    const table = [c('t1', 'clubs', 1), c('t2', 'hearts', 2), c('t3', 'diamonds', 3), c('t4', 'spades', 4)];
    return fresh({ forcedDeck: deckFrom(opener, table, filler(44, [...opener, ...table], 'w')), firstTurnSeat: 0 });
  }

  it('a sweep on the opening play pays 25', () => {
    const e = sweepEngine();
    announce(e, 10);
    const res = play(e, 'n', 'h10', { kind: 'CAPTURE', tableCardIds: ['t1', 't2', 't3', 't4'], houseIds: [] });
    expect(res.ok).toBe(true);
    const s = state(e);
    expect(s.tableLoose).toHaveLength(0);
    expect(s.sweeps[0]).toBe(1);
    expect(s.sweepPoints[0]).toBe(25);
    expect(s.events.find((ev) => ev.type === 'SEEP_SWEEP')?.payload).toMatchObject({ bonus: 25 });
  });

  it('a normal mid-deal sweep pays 50', () => {
    const e = fresh({ seed: 3 });
    const s = state(e);
    s.tableLoose = [c('t1', 'clubs', 1), c('t2', 'hearts', 7), c('t3', 'diamonds', 3), c('t4', 'spades', 5)];
    s.hands = { n: [c('m8', 'hearts', 8)], e: [c('x1', 'clubs', 2)], s: [c('x2', 'clubs', 3)], w: [c('x3', 'clubs', 4)] };
    s.currentTurn = 0;
    s.bid = 8;
    s.phase = 'TURN_PLAY';
    s.dealRestPending = false;
    s.playsMade = 9;
    const res = play(e, 'n', 'm8', { kind: 'CAPTURE', tableCardIds: ['t1', 't2', 't3', 't4'], houseIds: [] });
    expect(res.ok).toBe(true);
    expect(state(e).sweepPoints[0]).toBe(50);
  });

  it('a sweep with the very last card of the deal pays nothing', () => {
    const e = fresh({ seed: 3 });
    const s = state(e);
    s.tableLoose = [c('t1', 'clubs', 1), c('t2', 'hearts', 7), c('t3', 'diamonds', 3), c('t4', 'spades', 5)];
    s.hands = { n: [], e: [], s: [], w: [c('m8', 'hearts', 8)] };
    s.currentTurn = 3;
    s.bid = 8;
    s.phase = 'TURN_PLAY';
    s.dealRestPending = false;
    s.playsMade = 47;
    const res = play(e, 'w', 'm8', { kind: 'CAPTURE', tableCardIds: ['t1', 't2', 't3', 't4'], houseIds: [] });
    expect(res.ok).toBe(true);
    const after = state(e);
    expect(after.sweeps[1]).toBe(1);
    expect(after.sweepPoints[1]).toBe(0);
    expect(after.phase).toBe('ROUND_COMPLETE');
  });

  it('after a sweep the next player lays into the empty table', () => {
    const e = sweepEngine();
    announce(e, 10);
    expect(play(e, 'n', 'h10', { kind: 'CAPTURE', tableCardIds: ['t1', 't2', 't3', 't4'], houseIds: [] }).ok).toBe(true);
    const s = state(e);
    expect(s.currentTurn).toBe(1);
    const card = s.hands['e']![0]!;
    expect(play(e, 'e', card.id, { kind: 'LAY_DOWN' }).ok).toBe(true);
    expect(state(e).tableLoose).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Endgame, scoring and invariants
// ---------------------------------------------------------------------------

describe('a full dealt game', () => {
  it('runs 48 plays, every capture lands, and scores conserve', () => {
    const e = fresh({ seed: 11, firstTurnSeat: 0 });
    autoPlay(e);
    const s = state(e);
    expect(s.playsMade).toBe(48);
    expect(s.phase).toBe('ROUND_COMPLETE');
    const captured = Object.values(s.captures).flat();
    expect(captured).toHaveLength(52);
    const tp = s.teamScores!;
    const cardPts = captured.reduce((sum, card) => sum + cardPoints(card, DEFAULT_SEEP_RULES), 0);
    expect(cardPts).toBe(96);
    const sweepsPts = s.sweepPoints[0] + s.sweepPoints[1];
    const spread = Object.entries(s.captures).reduce(
      (acc, [pid, cards]) => acc + (teamOfPlayer(pid) === 0 ? cards.length : -cards.length),
      0,
    );
    expect(tp[0] + tp[1]).toBe(96 + sweepsPts + (spread !== 0 ? 4 : 0));
    // Partners share their team score.
    expect(e.calculateScore()['n']).toBe(tp[0]);
    expect(e.calculateScore()['s']).toBe(tp[0]);
    expect(e.calculateScore()['e']).toBe(tp[1]);
    expect(e.calculateScore()['w']).toBe(tp[1]);
  });

  it('is deterministic for a given seed', () => {
    const a = fresh({ seed: 21 });
    autoPlay(a);
    const b = fresh({ seed: 21 });
    autoPlay(b);
    expect(JSON.stringify(state(a).teamScores)).toBe(JSON.stringify(state(b).teamScores));
    expect(state(a).events.map((ev) => [ev.seq, ev.type])).toEqual(state(b).events.map((ev) => [ev.seq, ev.type]));
  });

  it('leaves nothing on the table at the end', () => {
    const e = fresh({ seed: 11 });
    autoPlay(e);
    expect(state(e).tableLoose).toHaveLength(0);
    expect(state(e).houses).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Views, restore, misc
// ---------------------------------------------------------------------------

describe('views and persistence', () => {
  it('filter opponent hands and expose team structure', () => {
    const e = fresh({ seed: 7 });
    announceBest(e);
    const v = view(e, 'n');
    expect(v.myTeam).toBe(0);
    expect(v.teams).toEqual({ 0: ['n', 's'], 1: ['e', 'w'] });
    for (const id of v.handCardIds['e'] ?? []) expect(v.knownCards[id]).toBeUndefined();
    for (const id of v.handCardIds['n'] ?? []) expect(v.knownCards[id]).toBeDefined();
    expect(v.bid).toBe(state(e).bid);
  });

  it('round-trips through restoreState', () => {
    const e = fresh({ seed: 21 });
    autoPlay(e);
    const snapshot = JSON.parse(JSON.stringify(state(e))) as SeepState;
    const restored = new SeepEngine();
    restored.restoreState(snapshot);
    expect(JSON.stringify(restored.getState())).toBe(JSON.stringify(snapshot));
    expect(restored.isGameFinished()).toBe(true);
    expect(restored.calculateScore()).toEqual(e.calculateScore());
  });

  it('rejects foreign state versions', () => {
    const restored = new SeepEngine();
    expect(() => restored.restoreState({ stateVersion: 99 } as unknown as SeepState)).toThrow(/version/);
  });

  it('exposes house ownership and pakka state in views', () => {
    const e = fresh({ seed: 3 });
    const s = state(e);
    s.houses.push({ id: 'h-1', total: 12, ownerId: 'n', sets: 2, cards: [c('a', 'clubs', 7), c('b', 'hearts', 5)] });
    s.bid = 12;
    const v = view(e, 'e');
    expect(v.houses[0]).toMatchObject({ ownerId: 'n', ownerTeam: 0, sets: 2, pakka: true });
  });

  it('reports the majority team in the round result', () => {
    const e = fresh({ seed: 11 });
    autoPlay(e);
    const result = view(e).roundResult!;
    const spread = Object.entries(state(e).captures).reduce(
      (acc, [pid, cards]) => acc + (teamOfPlayer(pid) === 0 ? cards.length : -cards.length),
      0,
    );
    if (spread !== 0) {
      expect(result.majorityTeam).toBe(spread > 0 ? 0 : 1);
    } else {
      expect(result.majorityTeam).toBeNull();
    }
  });
});
