import { describe, it, expect } from 'vitest';
import { standardDeck, type Card, type Suit } from '@shared/cards.js';
import { collectSeepFlights } from '../src/seep/flights.js';
import { allIntents, intentsForCard, biddableValues } from '../src/seep/seepCandidates.js';
import type { SeepPlayerView } from '@seep/views.js';
import type { SeepTeam } from '@seep/rules.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const c = (id: string, suit: Suit, rank: number): Card => ({ id, suit, rank });

interface MiniPlayer {
  id: string;
  name: string;
  cardCount: number;
  isCurrentTurn: boolean;
}

function basePlayers(): MiniPlayer[] {
  return [
    { id: 'n', name: 'N', cardCount: 4, isCurrentTurn: true },
    { id: 'e', name: 'E', cardCount: 4, isCurrentTurn: false },
    { id: 's', name: 'S', cardCount: 4, isCurrentTurn: false },
    { id: 'w', name: 'W', cardCount: 4, isCurrentTurn: false },
  ];
}

function view(opts: {
  hand?: Card[];
  table?: Card[];
  houses?: SeepPlayerView['houses'];
  events?: SeepPlayerView['events'];
  batchesRemaining?: number;
  currentTurn?: string;
  phase?: SeepPlayerView['phase'];
  bid?: number | null;
  playsMade?: number;
}): SeepPlayerView {
  const hand = opts.hand ?? [];
  const table = opts.table ?? [];
  const known: Record<string, Card> = {};
  for (const card of hand) known[card.id] = card;
  for (const card of table) known[card.id] = card;
  for (const h of opts.houses ?? []) for (const card of h.cards) known[card.id] = card;
  const current = opts.currentTurn ?? 'n';
  return {
    gameId: 'seep',
    revision: 1,
    phase: opts.phase ?? 'TURN_PLAY',
    players: basePlayers().map((p) => ({ ...p, isCurrentTurn: p.id === current, cardCount: p.id === 'n' ? hand.length : 4 })),
    knownCards: known,
    handCardIds: {
      n: hand.map((x) => x.id),
      e: ['e1', 'e2', 'e3', 'e4'],
      s: ['s1', 's2', 's3', 's4'],
      w: ['w1', 'w2', 'w3', 'w4'],
    },
    deckCount: 32,
    discardTop: null,
    events: (opts.events ?? []) as SeepPlayerView['events'],
    myTeam: 0,
    teams: { 0: ['n', 's'], 1: ['e', 'w'] },
    tableLoose: table,
    tableFaceDownCount: 0,
    houses: opts.houses ?? [],
    handCounts: { n: hand.length, e: 4, s: 4, w: 4 },
    captureCounts: { n: 0, e: 0, s: 0, w: 0 },
    sweeps: { 0: 0, 1: 0 },
    inspectableCardIds: [],
    teamPoints: { 0: 0, 1: 0 },
    bid: opts.bid ?? null,
    openerId: 'n',
    bidderId: 'n',
    playsMade: opts.playsMade ?? 1,
    batchesRemaining: opts.batchesRemaining ?? 0,
    lastCaptureTeam: null,
    majorityTeam: null,
    roundResult: null,
  } as SeepPlayerView;
}

const house = (id: string, total: number, ownerTeam: 0 | 1, cards: Card[], pakka = false): SeepPlayerView['houses'][number] => ({
  id,
  total,
  ownerByTeam: { [ownerTeam]: ownerTeam === 0 ? 'n' : 'e' } as SeepPlayerView['houses'][number]['ownerByTeam'],
  owners: [ownerTeam === 0 ? 'n' : 'e'],
  copies: cards.reduce((s, x) => s + x.rank, 0) / total,
  pakka,
  cards,
});

const ev = (seq: number, type: string, payload: Record<string, unknown>) => ({
  seq,
  type,
  timestamp: new Date().toISOString(),
  payload,
});

// ---------------------------------------------------------------------------
// flights
// ---------------------------------------------------------------------------

describe('collectSeepFlights', () => {
  it('animates a lay as a flight to the card’s new table slot', () => {
    const prev = view({});
    const next = view({ events: [ev(1, 'PLAY_LAY', { playerId: 'n', cardId: 'n9' })] });
    const flights = collectSeepFlights(prev, next);
    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({ fromPlayerId: 'n', fromCardId: 'n9', toDiscard: true, toCardId: 'n9' });
  });

  it('animates a capture as one flight per captured card plus the played card', () => {
    const prev = view({});
    const next = view({
      events: [ev(2, 'PLAY_CAPTURE', { playerId: 'e', cardId: 'e5', capturedIds: ['t1', 't2'] })],
    });
    const flights = collectSeepFlights(prev, next, 'n');
    expect(flights).toHaveLength(3);
    // Everything lands in the capturer's pile (east is not me).
    expect(flights.filter((f) => f.toPlayerId === 'e')).toHaveLength(3);
    // The played card is marked as its own flight.
    expect(flights.find((f) => f.id.endsWith('-played'))).toBeDefined();
  });

  it('lands build/add cards on the house stack element', () => {
    const prev = view({});
    const next = view({
      events: [
        ev(3, 'PLAY_BUILD', { playerId: 'n', cardId: 'n1', houseId: 'h-1', total: 11 }),
        ev(4, 'PLAY_ADD', { playerId: 's', cardId: 's1', houseId: 'h-1', total: 11 }),
      ],
    });
    const flights = collectSeepFlights(prev, next);
    expect(flights.map((f) => f.toCardId)).toEqual(['h-1', 'h-1']);
  });

  it('animates a batch deal from the deck to every seat', () => {
    const prev = view({ batchesRemaining: 2 });
    const next = view({ batchesRemaining: 1, events: [ev(6, 'BATCH_DEALT', { batch: 2 })] });
    const flights = collectSeepFlights(prev, next, 'n');
    expect(flights).toHaveLength(4);
    // My own batch has no toPlayerId (lands in my draw area).
    expect(flights.find((f) => f.id.endsWith('-n'))!.toPlayerId).toBeUndefined();
    expect(flights.find((f) => f.id.endsWith('-e'))!.toPlayerId).toBe('e');
  });

  it('ignores sweep/turn/round events', () => {
    const prev = view({});
    const next = view({
      events: [
        ev(5, 'SEEP_SWEEP', { playerId: 'n', team: 0 }),
        ev(6, 'TURN_STARTED', { playerId: 'e' }),
        ev(7, 'ROUND_COMPLETE', { teamScores: { 0: 1, 1: 0 } }),
      ],
    });
    expect(collectSeepFlights(prev, next)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// seepCandidates
// ---------------------------------------------------------------------------

describe('intentsForCard', () => {
  it('finds single and set-sum captures', () => {
    const v = view({
      hand: [c('m1', 'hearts', 8), c('m2', 'clubs', 3)],
      table: [c('t1', 'spades', 3), c('t2', 'diamonds', 5), c('t3', 'spades', 9)],
    });
    const intents = intentsForCard(v, 'm1', 'n');
    // 8 = 3+5 (t1+t2). The single 3 matches m2, not m1.
    expect(intents.captures).toEqual([{ tableCardIds: ['t1', 't2'], houseIds: [] }]);
    expect(intents.canLay).toBe(false);

    const intents2 = intentsForCard(v, 'm2', 'n');
    expect(intents2.captures).toEqual([{ tableCardIds: ['t1'], houseIds: [] }]);
  });

  it('captures several groups at once: with an 8 take A+7, 3+5 and a loose 8', () => {
    const v = view({
      hand: [c('m1', 'hearts', 8)],
      table: [
        c('t1', 'spades', 1), c('t2', 'diamonds', 7),
        c('t3', 'clubs', 3), c('t4', 'spades', 5),
        c('t5', 'hearts', 8),
      ],
    });
    const intents = intentsForCard(v, 'm1', 'n');
    // Compulsory capture-all: the three non-overlapping 8-groups form ONE
    // maximal collection — exactly one choice, the whole-table sweep.
    expect(intents.captures).toEqual([{ tableCardIds: ['t1', 't2', 't3', 't4', 't5'], houseIds: [] }]);
    expect(intents.canLay).toBe(false);
  });

  it('gates every intent on the opening play to the announced number', () => {
    const v = view({
      hand: [c('m1', 'hearts', 9), c('m2', 'clubs', 3)],
      table: [c('t1', 'spades', 3), c('t2', 'diamonds', 6)],
      bid: 9,
      playsMade: 0,
    });
    // The 9 relates to the bid: it captures 3+6 (must-capture, so no lay).
    const nine = intentsForCard(v, 'm1', 'n');
    expect(nine.captures).toEqual([{ tableCardIds: ['t1', 't2'], houseIds: [] }]);
    expect(nine.canLay).toBe(false);
    // The 3 matches a table card, but on the opening play only the bid counts.
    const three = intentsForCard(v, 'm2', 'n');
    expect(three.captures).toEqual([]);
    expect(three.canLay).toBe(false);
    // A build of the bid total (3+6=9, backed by m1) is legal with the 3.
    expect(three.builds.map((b) => b.total)).toEqual([9]);
  });

  it('lists only held 9–13 values as biddable', () => {
    const v = view({
      phase: 'ANNOUNCE',
      hand: [c('m1', 'hearts', 9), c('m2', 'clubs', 2), c('m3', 'spades', 13), c('m4', 'diamonds', 8)],
    });
    expect(biddableValues(v, 'n')).toEqual([13, 9]);
  });

  it('marks canLay true and skips builds when nothing is capturable', () => {
    const v = view({
      hand: [c('m1', 'hearts', 2)],
      table: [c('t1', 'spades', 9)],
    });
    const intents = intentsForCard(v, 'm1', 'n');
    expect(intents.canLay).toBe(true);
    expect(intents.captures).toEqual([]);
    // Build 11 (2+9) requires holding an 11 — we don't.
    expect(intents.builds).toEqual([]);
  });

  it('proposes builds when the total is backed in hand', () => {
    const v = view({
      hand: [c('m1', 'hearts', 6), c('m2', 'spades', 11)],
      table: [c('t1', 'diamonds', 5)],
    });
    const intents = intentsForCard(v, 'm1', 'n');
    expect(intents.builds).toEqual([{ tableCardIds: ['t1'], total: 11 }]);
    expect(intents.canLay).toBe(true); // 6 captures nothing
  });

  it('takes every matching ghar at once; cements own and (backed) opponent ghars', () => {
    const v = view({
      // Two twelves: one to play, one to keep as the owner's backing.
      hand: [c('m1', 'hearts', 12), c('m2', 'spades', 12)],
      table: [],
      houses: [house('h-1', 12, 0, [c('a', 'spades', 12)]), house('h-2', 12, 1, [c('b', 'clubs', 12)])],
    });
    const intents = intentsForCard(v, 'm1', 'n');
    // Both 12-ghars stand on the table — a capture must take BOTH.
    expect(intents.captures).toEqual([{ tableCardIds: [], houseIds: ['h-1', 'h-2'] }]);
    expect(intents.capturableHouseIds).toEqual(['h-1', 'h-2']);
    // Cement: own ghar (m2 backs) and the opponent's (backing lets me co-own).
    expect(intents.addableHouses).toEqual([
      { houseId: 'h-1', tableCardIds: [] },
      { houseId: 'h-2', tableCardIds: [] },
    ]);
    expect(intents.breakableHouses).toEqual([]);
  });

  it('my last matching card may still cement a ghar — no deadlock', () => {
    const mine = intentsForCard(
      view({ hand: [c('m1', 'hearts', 12)], houses: [house('h-1', 12, 0, [c('a', 'spades', 12)])] }),
      'm1', 'n',
    );
    expect(mine.addableHouses).toEqual([{ houseId: 'h-1', tableCardIds: [] }]);
    const partners = intentsForCard(
      view({ hand: [c('m1', 'hearts', 12)], houses: [{ ...house('h-1', 12, 0, [c('a', 'spades', 12)]), ownerByTeam: { 0: 's' }, owners: ['s'] }] }),
      'm1', 'n',
    );
    expect(partners.addableHouses).toEqual([{ houseId: 'h-1', tableCardIds: [] }]);
  });

  it('proposes breaking an opponent kachcha ghar when the new total is held', () => {
    const v = view({
      hand: [c('m1', 'hearts', 2), c('m2', 'spades', 11)],
      table: [],
      houses: [
        house('h-1', 9, 1, [c('b1', 'clubs', 9)]),
        house('h-2', 10, 1, [c('b2', 'clubs', 10), c('b3', 'hearts', 9), c('b4', 'diamonds', 1)], true),
      ],
    });
    const intents = intentsForCard(v, 'm1', 'n'); // 2 → break 9 to 11, J in hand
    expect(intents.breakableHouses).toEqual([{ houseId: 'h-1', newTotal: 11 }]);
    expect(intents.breakableHouses.map((b) => b.houseId)).not.toContain('h-2'); // pakka locked
  });

  it('own-ghar adds require a backing card unless it is my last one', () => {
    // A spare 5 stays behind — playing the 12 leaves no 12 to keep: blocked.
    const blocked = intentsForCard(
      view({
        hand: [c('m1', 'hearts', 12), c('m2', 'clubs', 5)],
        houses: [house('h-1', 12, 0, [c('a', 'spades', 12)])],
      }),
      'm1', 'n',
    );
    expect(blocked.addableHouses).toEqual([]);
    // Last-card relaxation: with nothing left behind the cement is allowed.
    const last = intentsForCard(
      view({
        hand: [c('m1', 'hearts', 12)],
        houses: [house('h-1', 12, 0, [c('a', 'spades', 12)])],
      }),
      'm1', 'n',
    );
    expect(last.addableHouses).toEqual([{ houseId: 'h-1', tableCardIds: [] }]);
  });

  it('ignores cards that are not in my hand', () => {
    const v = view({ hand: [c('m1', 'hearts', 5)], table: [c('t1', 'spades', 5)] });
    expect(intentsForCard(v, 't1', 'n').captures).toEqual([]);
  });

  it('enumerate over the whole hand via allIntents', () => {
    const v = view({
      hand: [c('m1', 'hearts', 5), c('m2', 'clubs', 7)],
      table: [c('t1', 'spades', 5)],
    });
    const all = allIntents(v, 'n');
    expect(Object.keys(all)).toEqual(['m1', 'm2']);
    expect(all['m1']!.captures).toEqual([{ tableCardIds: ['t1'], houseIds: [] }]);
    expect(all['m2']!.canLay).toBe(true);
  });

  it('sanity: the default deck still contains every standard card', () => {
    expect(standardDeck()).toHaveLength(52);
  });
});
