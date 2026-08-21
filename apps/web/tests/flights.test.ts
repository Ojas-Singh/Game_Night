import { describe, it, expect } from 'vitest';
import { collectFlights } from '../src/useRoom.js';
import type { CaboPlayerView } from '@cabo/views.js';

/** Minimal view carrying only the event log (the only field collectFlights reads). */
function view(events: Array<{ seq: number; type: string; playerId?: string; payload?: Record<string, unknown> }>): CaboPlayerView {
  return {
    events: events as CaboPlayerView['events'],
  } as unknown as CaboPlayerView;
}

describe('collectFlights', () => {
  it('maps a flush to a flight from the source player to the discard', () => {
    const next = view([
      {
        seq: 1,
        type: 'CARD_FLUSHED',
        playerId: 'A',
        payload: { sourcePlayerId: 'A', cardId: 'c1', rank: 9 },
      },
    ]);
    const flights = collectFlights(view([]), next);
    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({ fromPlayerId: 'A', toDiscard: true, rank: 9 });
  });

  it('maps a flush of another players card to that players seat', () => {
    const next = view([
      {
        seq: 2,
        type: 'CARD_FLUSHED',
        playerId: 'B', // actor
        payload: { sourcePlayerId: 'C', cardId: 'c2', rank: 3 }, // owner
      },
    ]);
    const flights = collectFlights(view([]), next);
    expect(flights[0].fromPlayerId).toBe('C');
    expect(flights[0].toDiscard).toBe(true);
  });

  it('maps a discard / replaced card to a flight to the discard', () => {
    const next = view([
      { seq: 3, type: 'CARD_DISCARDED', playerId: 'D', payload: { cardId: 'x', rank: 7 } },
      { seq: 4, type: 'CARD_REPLACED', playerId: 'E', payload: { cardId: 'y', rank: 5 } },
    ]);
    const flights = collectFlights(view([]), next);
    expect(flights.map((f) => [f.fromPlayerId, f.toDiscard, f.rank])).toEqual([
      ['D', true, 7],
      ['E', true, 5],
    ]);
  });

  it('maps a draw to a face-down flight FROM the deck (no rank leaked)', () => {
    const next = view([
      { seq: 5, type: 'CARD_DRAWN', playerId: 'F', payload: { deckCount: 20 } },
    ]);
    const flights = collectFlights(view([]), next);
    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({ fromPlayerId: 'deck', toDiscard: false });
    // Hidden-info safety: the drawn card's value is never put in the event.
    expect(flights[0].rank).toBe(0);
  });

  it('maps a secret penalty card to a face-down flight landing in that player hand', () => {
    const next = view([{ seq: 8, type: 'PENALTY_DRAWN', playerId: 'P', payload: { count: 1 } }]);
    const flights = collectFlights(view([]), next);
    expect(flights).toHaveLength(1);
    expect(flights[0]).toMatchObject({
      fromPlayerId: 'deck',
      toDiscard: false,
      toPlayerId: 'P',
      rank: 0,
    });
  });

  it('only reports events newer than the previous view (delta)', () => {
    const prev = view([{ seq: 1, type: 'CARD_DISCARDED', playerId: 'A', payload: { rank: 4 } }]);
    const next = view([
      { seq: 1, type: 'CARD_DISCARDED', playerId: 'A', payload: { rank: 4 } },
      { seq: 2, type: 'CARD_FLUSHED', playerId: 'B', payload: { sourcePlayerId: 'B', rank: 8 } },
    ]);
    const flights = collectFlights(prev, next);
    expect(flights).toHaveLength(1);
    expect(flights[0].seq).toBe(2);
  });

  it('ignores non-movement events', () => {
    const next = view([
      { seq: 6, type: 'CABO_CALLED', playerId: 'A' },
      { seq: 7, type: 'CHAT', payload: { text: 'hi' } },
    ]);
    expect(collectFlights(view([]), next)).toHaveLength(0);
  });
});
