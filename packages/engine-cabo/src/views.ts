/**
 * Per-player filtered views of the Cabo state.
 *
 * Hidden information security: a viewer only receives card VALUES for ids
 * present in their own knowledge set. Everything else travels as opaque ids.
 */

import type { Card, GameEvent, PlayerView } from '@game-night/shared';
import type { CaboState } from './types.js';

export interface CaboPlayerView extends PlayerView {
  /** Current pending power prompt, only when owed by the viewer. */
  pendingPower: { power: string; sourceCardId: string } | null;
  /** Pending transfer owed by the viewer. */
  pendingTransfer: { toPlayerId: string } | null;
  /** The card the viewer drew (value included — it is theirs). */
  drawnCard: Card | null;
  /** Viewer still owes their initial peek. */
  needsInitialPeek: boolean;
  cabo: { callerId: string } | null;
  scores: Record<string, number> | null;
  roundWinnerId: string | null;
  tiedWinnerIds: string[];
  /** Rank of the discard top — drives flush prompts. Null when empty. */
  discardTopRank: number | null;
}

export function buildPlayerView(state: CaboState, viewerId: string, opts?: { revealAll?: boolean }): CaboPlayerView {
  const known: Record<string, Card> = {};
  // Normal play: a viewer only receives card values for ids in their own
  // knowledge set. revealAll (Test Mode) additionally exposes every card's
  // value so a tester can watch the full flow.
  const revealAll = opts?.revealAll === true;
  const knownIds = new Set(state.knowledge[viewerId] ?? []);
  const allCards: Card[] = [
    ...state.deck,
    ...state.discard,
    ...(state.drawnCard ? [state.drawnCard] : []),
    ...state.players.flatMap((p) => state.hands[p.id] ?? []),
  ];
  for (const card of allCards) {
    if (revealAll || knownIds.has(card.id)) known[card.id] = card;
  }

  const handCardIds: Record<string, string[]> = {};
  for (const p of state.players) {
    handCardIds[p.id] = (state.hands[p.id] ?? []).map((c) => c.id);
  }

  const discardTop = state.discard[state.discard.length - 1] ?? null;
  const events: GameEvent[] = state.events;
  const isCurrent = state.players[state.currentTurn]?.id === viewerId;

  return {
    revision: state.revision,
    phase: state.phase,
    players: state.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      cardCount: state.hands[p.id]?.length ?? 0,
      isCurrentTurn: i === state.currentTurn,
    })),
    knownCards: known,
    handCardIds,
    deckCount: state.deck.length,
    discardTop,
    events,
    pendingPower:
      state.pendingPower && state.pendingPower.playerId === viewerId
        ? { power: state.pendingPower.power, sourceCardId: state.pendingPower.sourceCardId }
        : null,
    pendingTransfer:
      state.pendingTransfer && state.pendingTransfer.fromPlayerId === viewerId
        ? { toPlayerId: state.pendingTransfer.toPlayerId }
        : null,
    drawnCard: state.drawnCard && isCurrent ? state.drawnCard : null,
    needsInitialPeek: state.initialPeeksRemaining.includes(viewerId),
    cabo: state.cabo ? { callerId: state.cabo.callerId } : null,
    scores: state.scores,
    roundWinnerId: state.roundWinnerId,
    tiedWinnerIds: state.tiedWinnerIds,
    discardTopRank: discardTop?.rank ?? null,
  };
}
