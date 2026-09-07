/**
 * Pure series-goal helpers: shared by the lobby standings and the in-game
 * winner banner. Kept side-effect free so both views (and tests) agree on
 * exactly when a series is won.
 */

import type { LobbyPlayer } from '../server-protocol.js';

export interface SeriesStanding {
  playerId: string;
  name: string;
  wins: number;
  isAi: boolean;
}

/** Players with their series win counts, best first; ties keep join order. */
export function seriesStandings(
  scoreboard: Record<string, number>,
  players: readonly LobbyPlayer[],
): SeriesStanding[] {
  return players
    .map((p) => ({ playerId: p.id, name: p.name, wins: scoreboard[p.id] ?? 0, isAi: p.kind === 'ai' }))
    .sort((a, b) => b.wins - a.wins);
}

/** The player who has reached the target, or null while nobody has. When
 *  several reach it in the same round the top score wins. */
export function seriesWinner(
  scoreboard: Record<string, number>,
  target: number | null | undefined,
): SeriesStanding | null {
  if (target == null || target < 1) return null;
  const entries = Object.entries(scoreboard).filter(([, wins]) => wins >= target);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return { playerId: entries[0]![0], name: '', wins: entries[0]![1], isAi: false };
}
