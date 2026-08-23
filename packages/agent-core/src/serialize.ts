/**
 * View → text serializers.
 *
 * Two consumers: LLM agents (prompt = rules + serialized observation) and
 * trajectory files (human/auditable episode transcripts). The output must be
 * COMPLETE for decision-making: every legal-move ingredient the view carries
 * appears in the text.
 */

import { RANK_LABELS } from '@game-night/shared';
import type { CaboPlayerView } from '@game-night/engine-cabo';
import type { PairOnePlayerView } from '@game-night/engine-pairone';
import type { AnyGameView, GameId } from './types.js';

export const RULES_TEXT: Record<GameId, string> = {
  cabo: `CABO — a memory/golf-style card game. Each player has 4 face-down cards; LOWEST total hand wins.
Card values: A=1..10=10, J=11, Q=12, K=13 EXCEPT black Kings = -1. Match the discard pile's rank to FLUSH matching cards out of your hand (pairs allowed). Wrong flush attempts draw penalty cards.
Turn flow: DRAW a card -> either KEEP it by swapping into one of your hand slots (the swapped card goes to discard), or DISCARD it. If the discarded card's rank carries a power you must use it:
  7-8 PEEK_OWN: look at one of your cards. 9-10 PEEK_OTHER: look at another player's card.
  J-Q BLIND_SWAP: swap one of your cards with another player's card without looking. (5-6 SWAP_OTHERS only if house rule enabled.)
At ANY moment on your turn you may also flush: if the discard top is rank R and you KNOW some card(s) of rank R (yours or others'), throw them onto the pile. Correct guesses remove cards; wrong ones penalize.
When your hand value is (probably) lowest, CALL_CABO at the end of your action instead of ending normally. Everyone else gets one final turn, then hands reveal; lowest total wins, caller ties/loses are punished in scoring.`,
  pairone: `PAIR ONE — a public memory game. One full deck (52 cards) fills a fixed grid, all face down. Positions never move; collected pairs leave permanent gaps.
On your turn flip any two grid cards (everyone sees them). If ranks match you COLLECT the pair and immediately flip again (same turn continues). If they don't match, both flip back and your turn ends.
Round ends when the grid is empty; MOST pairs collected wins (ties shared). Perfect memory of every flip ever shown wins games.`,
};

function cardLabel(view: AnyGameView, id: string): string {
  const c = view.knownCards[id];
  return c ? `${RANK_LABELS[c.rank]}${c.suit === 'hearts' || c.suit === 'diamonds' ? '♥' : c.suit === 'spades' ? '♠' : '♣'}` : '?';
}

export function serializeCaboView(v: CaboPlayerView, selfId: string): string {
  const lines: string[] = [];
  lines.push(`phase=${v.phase} deck=${v.deckCount}`);
  const top = v.discardTop;
  lines.push(`discard_top=${top ? `${RANK_LABELS[top.rank]}${top.suit[0]!.toUpperCase()}` : 'none'} (rank ${v.discardTopRank ?? '-'} open for flushes)`);
  const names = new Map(v.players.map((p) => [p.id, p.name]));
  for (const p of v.players) {
    const ids = v.handCardIds[p.id] ?? [];
    const hand =
      p.id === selfId || v.phase === 'ROUND_REVEAL' || v.phase === 'ROUND_COMPLETE'
        ? ids.map((id) => (id.startsWith('__slot__') ? '·' : cardLabel(v, id))).join(' ')
        : ids.map((id) => (id.startsWith('__slot__') ? '·' : cardLabel(v, id))).join(' ');
    lines.push(
      `${p.isCurrentTurn ? '>' : ' '} ${p.id === selfId ? 'YOU' : names.get(p.id) ?? p.id}: [${hand}] (${p.cardCount})`,
    );
  }
  if (v.drawnCard) {
    lines.push(`you_drew=${RANK_LABELS[v.drawnCard.rank]}${v.drawnCard.suit[0]!.toUpperCase()} — keep (swap into a slot) or discard`);
  }
  if (v.pendingPower) lines.push(`power_pending=${v.pendingPower.power} (from your discarded card)`);
  if (v.pendingTransfer) lines.push(`transfer_pending: give one of YOUR cards to ${names.get(selfId) === undefined ? v.pendingTransfer.toPlayerId : 'the player whose card you flushed'}`);
  if (v.cabo) {
    const caller = v.players.find((p) => p.id === v.cabo!.callerId);
    lines.push(`CABO called by ${caller?.name ?? v.cabo.callerId} — final turns underway`);
  }
  const recent = v.events.slice(-6);
  if (recent.length > 0) {
    lines.push('recent_events=' + recent.map((e) => e.type.toLowerCase()).join(','));
  }
  return lines.join('\n');
}

export function serializePairOneView(v: PairOnePlayerView, selfId: string): string {
  const lines: string[] = [];
  const cols = v.gridCols;
  const rows = Math.ceil(v.gridCardIds.length / cols);
  lines.push(`phase=${v.phase} remaining=${v.remainingCount}/${v.gridCardIds.length} face_up=[${v.faceUpCardIds.map((i) => cardLabel(v, i)).join(' ') || '-'}]`);
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const i = r * cols + cIdx;
      const id = v.gridCardIds[i];
      cells.push(id == null ? '  ' : id.startsWith('__empty__') ? ' .' : cardLabel(v, id));
    }
    lines.push(`r${String(r).padStart(2, '0')}| ${cells.join(' | ')}`);
  }
  const knownPairs: string[] = [];
  const byRank = new Map<number, string[]>();
  for (const [id, card] of Object.entries(v.knownCards)) {
    if (!v.gridCardIds.includes(id)) continue;
    const arr = byRank.get(card.rank) ?? [];
    arr.push(id);
    byRank.set(card.rank, arr);
  }
  for (const [rank, ids] of byRank) {
    if (ids.length >= 2) knownPairs.push(`${RANK_LABELS[rank as keyof typeof RANK_LABELS]}×${ids.length}`);
  }
  if (knownPairs.length > 0) lines.push(`known_matching_on_table=${knownPairs.join(',')}`);
  const names = new Map(v.players.map((p) => [p.id, p.name]));
  for (const p of v.players) {
    lines.push(`${p.isCurrentTurn ? '>' : ' '} ${p.id === selfId ? 'YOU' : names.get(p.id) ?? p.id}: ${p.cardCount} pairs`);
  }
  return lines.join('\n');
}

/** Serialize any view for `selfId` into the text block agents consume. */
export function serializeView(view: AnyGameView, selfId: string): string {
  return view.gameId === 'cabo' ? serializeCaboView(view, selfId) : serializePairOneView(view, selfId);
}
