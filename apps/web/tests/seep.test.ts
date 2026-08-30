import { describe, it, expect } from 'vitest';
import { standardDeck, type Card, type Suit } from '@shared/cards.js';
import { collectSeepFlights } from '../src/seep/flights.js';
import { allIntents, intentsForCard } from '../src/seep/seepCandidates.js';
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
    phase: 'TURN_PLAY',
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
    houses: opts.houses ?? [],
    captures: { n: [], e: [], s: [], w: [] },
    handCounts: { n: hand.length, e: 4, s: 4, w: 4 },
    sweeps: { 0: 0, 1: 0 },
    teamPoints: { 0: 0, 1: 0 },
    batchesRemaining: opts.batchesRemaining ?? 2,
    lastCaptureTeam: null,
    roundResult: null,
  } as SeepPlayerView;
}

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

  it('lands build/raise cards on the house stack element', () => {
    const prev = view({});
    const next = view({
      events: [
        ev(3, 'PLAY_BUILD', { playerId: 'n', cardId: 'n1', houseId: 'h-1', total: 11 }),
        ev(4, 'PLAY_RAISE', { playerId: 's', cardId: 's1', houseId: 'h-1', total: 11 }),
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
    expect(intents.captures).toEqual([['t1', 't2']]);
    expect(intents.canLay).toBe(false);

    const intents2 = intentsForCard(v, 'm2', 'n');
    expect(intents2.captures).toEqual([['t1']]);
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

  it('marks capturable and raiseable houses', () => {
    const v = view({
      // Two twelves: one to play, one to keep as the raise backing.
      hand: [c('m1', 'hearts', 12), c('m2', 'spades', 12)],
      table: [],
      houses: [
        { id: 'h-1', total: 12, ownerTeam: 0, cards: [c('a', 'spades', 12)] },
        { id: 'h-2', total: 12, ownerTeam: 1, cards: [c('b', 'clubs', 12)] },
      ] as SeepPlayerView['houses'],
    });
    const intents = intentsForCard(v, 'm1', 'n');
    // Both houses are capturable; only own team's (h-1) is raiseable.
    expect(intents.capturableHouseIds).toEqual(['h-1', 'h-2']);
    expect(intents.raiseHouseIds).toEqual(['h-1']);
  });

  it('requires a backing card for raises and never proposes them without one', () => {
    const v = view({
      hand: [c('m1', 'hearts', 12)],
      table: [],
      houses: [{ id: 'h-1', total: 12, ownerTeam: 0, cards: [c('a', 'spades', 12)] }] as SeepPlayerView['houses'],
    });
    const intents = intentsForCard(v, 'm1', 'n');
    expect(intents.raiseHouseIds).toEqual([]);
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
    expect(all['m1']!.captures).toEqual([['t1']]);
    expect(all['m2']!.canLay).toBe(true);
  });

  it('sanity: the default deck still contains every standard card', () => {
    expect(standardDeck()).toHaveLength(52);
  });
});
