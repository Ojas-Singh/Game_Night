/**
 * Per-player filtered views of the Cabo state.
 *
 * Hidden information security: a viewer only receives card VALUES for ids
 * present in their own knowledge set. Everything else travels as opaque ids.
 */

import type { Card, GameEvent, PlayerView } from '@game-night/shared';
import type { CaboState } from './types.js';

export interface CaboPlayerView extends PlayerView {
  /** Discriminator for the client (PairOnePlayerView carries 'pairone'). */
  gameId: 'cabo';
  /** Current pending power prompt, only when owed by the viewer. */
  pendingPower: { power: string; sourceCardId: string } | null;
  /** Pending transfer owed by the viewer. */
  pendingTransfer: { toPlayerId: string } | null;
  /** The card the viewer drew (value included — it is theirs). */
  drawnCard: Card | null;
  /** Viewer still owes their initial peek. */
  needsInitialPeek: boolean;
  /** Card ids shown to this viewer at the start of the round. */
  initialPeekCardIds: string[];
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
  // Starting-peek metadata is viewer-scoped presentation state. Re-add its
  // ids explicitly so a restored/coalesced round still ships both values.
  for (const id of state.initialPeekCardIds?.[viewerId] ?? []) knownIds.add(id);
  // INITIAL_PEEK: your bottom two cards are yours to memorise from the deal,
  // so their values ship while you have not peeked yet. State-driven — no
  // event replay needed, survives reconnects and coalesced broadcasts.
  if (state.initialPeeksRemaining.includes(viewerId)) {
    const mine = state.hands[viewerId] ?? [];
    for (const idx of [1, 3]) {
      if (mine[idx]) knownIds.add(mine[idx]!.id);
    }
  }
  const allCards: Card[] = [
    ...state.deck,
    ...state.discard,
    ...(state.drawnCard ? [state.drawnCard] : []),
    ...state.players.flatMap((p) => (state.hands[p.id] ?? []).filter((c): c is Card => !!c)),
  ];
  for (const card of allCards) {
    if (revealAll || knownIds.has(card.id)) known[card.id] = card;
  }

  // Hands keep their physical layout: a flushed card leaves an empty slot,
  // surfaced as a "__slot__N" placeholder id so clients render the gap
  // instead of sliding the remaining cards together.
  const handCardIds: Record<string, string[]> = {};
  for (const p of state.players) {
    handCardIds[p.id] = (state.hands[p.id] ?? []).map((c, i) => c?.id ?? `__slot__${i}`);
  }

  const discardTop = state.discard[state.discard.length - 1] ?? null;
  const events: GameEvent[] = state.events;
  const isCurrent = state.players[state.currentTurn]?.id === viewerId;
  const pendingTransfers = state.pendingTransfers ?? (state.pendingTransfer ? [state.pendingTransfer] : []);
  const owedTransfer = pendingTransfers.find((transfer) => transfer.fromPlayerId === viewerId);

  return {
    revision: state.revision,
    phase: state.phase,
    gameId: 'cabo',
    players: state.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      cardCount: (state.hands[p.id] ?? []).filter((c) => !!c).length,
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
      owedTransfer
        ? { toPlayerId: owedTransfer.toPlayerId }
        : null,
    drawnCard: state.drawnCard && isCurrent ? state.drawnCard : null,
    needsInitialPeek: state.initialPeeksRemaining.includes(viewerId),
    cabo: state.cabo ? { callerId: state.cabo.callerId } : null,
    scores: state.scores,
    roundWinnerId: state.roundWinnerId,
    tiedWinnerIds: state.tiedWinnerIds,
    discardTopRank: discardTop?.rank ?? null,
    initialPeekCardIds: [...(state.initialPeekCardIds?.[viewerId] ?? [])],
  };
}
