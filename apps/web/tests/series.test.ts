/** Pure series-goal helpers. */

import { describe, expect, it } from 'vitest';
import { seriesStandings, seriesWinner } from '../src/lobby/series.js';
import type { LobbyPlayer } from '../src/server-protocol.js';

const players: LobbyPlayer[] = [
  { id: 'a', name: 'Ada', isHost: true, ready: true, connected: true, isYou: false, avatar: { color: 0, eyes: 0, mouth: 0, hat: 0 } },
  { id: 'b', name: 'Bot', isHost: false, ready: true, connected: true, isYou: false, kind: 'ai', avatar: { color: 1, eyes: 0, mouth: 0, hat: 0 } },
  { id: 'c', name: 'Cy', isHost: false, ready: true, connected: true, isYou: false, avatar: { color: 2, eyes: 0, mouth: 0, hat: 0 } },
];

describe('series', () => {
  it('orders standings best-first regardless of join order', () => {
    const standings = seriesStandings({ c: 3, a: 1 }, players);
    expect(standings.map((s) => s.playerId)).toEqual(['c', 'a', 'b']);
    expect(standings[0]).toMatchObject({ wins: 3, isAi: false });
    expect(standings[1]!.isAi).toBe(false);
  });

  it('reports no winner while the goal stands unreached', () => {
    expect(seriesWinner({ a: 1, c: 2 }, 3)).toBeNull();
    expect(seriesWinner({}, 2)).toBeNull();
    expect(seriesWinner({ a: 9 }, null)).toBeNull();
    expect(seriesWinner({ a: 9 }, undefined)).toBeNull();
  });

  it('picks the top score once someone reaches the target', () => {
    const winner = seriesWinner({ a: 2, c: 4, b: 5 }, 4);
    expect(winner).toMatchObject({ playerId: 'b', wins: 5 });
    // Tie: first entry with the top score wins (stable sort).
    const tied = seriesWinner({ b: 2, a: 2 }, 2);
    expect(tied?.playerId).toBe('b');
  });
});
