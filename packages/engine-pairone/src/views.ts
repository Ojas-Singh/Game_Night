/**
 * Per-viewer views of the Pair One state.
 *
 * Hidden-information model: cards nobody has flipped yet are opaque ids.
 * Every flip is PUBLIC, so each flip teaches EVERY player the card's value —
 * knowledge grows identically for all viewers as the round unfolds.
 */

import type { Card, GameEvent, PlayerView } from '@game-night/shared';
import { GRID_COLS } from './types.js';
import type { PairOneState } from './types.js';

export interface PairOnePlayerView extends PlayerView {
  /** Discriminator for the client (CaboPlayerView carries gameId 'cabo'). */
  gameId: 'pairone';
  /**
   * Grid card ids in row-major order. Collected cards surface as an
   * "__empty__N" placeholder so clients can keep every other card's position.
   */
  gridCardIds: string[];
  gridCols: number;
  /** Cards collected per player, in pickup order (public information). */
  collections: Record<string, Card[]>;
  /** Ids of the cards currently face-up mid-turn (0..2). */
  faceUpCardIds: string[];
  /** Cards still on the table. */
  remainingCount: number;
  /** Who missed last (flavour: shake those two slots). */
  lastMiss: { playerId: string; cardIds: string[] } | null;
  scores: Record<string, number> | null;
  roundWinnerId: string | null;
  tiedWinnerIds: string[];
}

export function buildPlayerView(
  state: PairOneState,
  viewerId: string,
  opts?: { revealAll?: boolean },
): PairOnePlayerView {
  const known: Record<string, Card> = {};
  // Normal play: only flipped (remembered) cards carry values. revealAll
  // (Test Mode) exposes every card on the table + collected piles.
  const revealAll = opts?.revealAll === true;
  const knownIds = new Set(state.knowledge[viewerId] ?? []);
  const tableCards: Card[] = state.grid.filter((c): c is Card => !!c);
  const collectedCards: Card[] = state.players.flatMap((p) => state.collections[p.id] ?? []);
  for (const card of [...tableCards, ...collectedCards]) {
    if (revealAll || knownIds.has(card.id)) known[card.id] = card;
  }

  const gridCardIds = state.grid.map((c, i) => c?.id ?? `__empty__${i}`);

  return {
    revision: state.revision,
    phase: state.phase,
    gameId: 'pairone',
    players: state.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      cardCount: Math.floor((state.collections[p.id]?.length ?? 0) / 2),
      isCurrentTurn: i === state.currentTurn,
    })),
    knownCards: known,
    handCardIds: {},
    deckCount: 0,
    discardTop: null,
    events: state.events as GameEvent[],
    gridCardIds,
    gridCols: GRID_COLS,
    collections: Object.fromEntries(state.players.map((p) => [p.id, state.collections[p.id] ?? []])),
    faceUpCardIds: [...state.flippedThisTurn],
    remainingCount: state.grid.reduce((n, c) => (c ? n + 1 : n), 0),
    lastMiss: state.lastMiss,
    scores: state.scores,
    roundWinnerId: state.roundWinnerId,
    tiedWinnerIds: state.tiedWinnerIds,
  };
}
