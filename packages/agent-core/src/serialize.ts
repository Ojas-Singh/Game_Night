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
import type { SeepPlayerView } from '@game-night/engine-seep';
import type { AnyGameView, GameId } from './types.js';

export const RULES_TEXT: Record<GameId, string> = {
  cabo: `CABO — a memory/golf-style card game. Each player has 4 face-down cards; LOWEST total hand wins.
Card values: A=1..10=10, J=11, Q=12, K=13 EXCEPT black Kings = -1. Match the discard pile's rank to FLUSH matching cards out of your hand (pairs allowed). Wrong flush attempts draw penalty cards.
Turn flow: DRAW a card -> either KEEP it by swapping into one of your hand slots (the swapped card goes to discard), or DISCARD it. If the discarded card's rank carries a power you must use it:
  7-8 PEEK_OWN: look at one of your cards. 9-10 PEEK_OTHER: look at another player's card.
  J-Q BLIND_SWAP: swap one of your cards with another player's card without looking.
At ANY moment on your turn you may also flush: if the discard top is rank R and you KNOW some card(s) of rank R (yours or others'), throw them onto the pile. Correct guesses remove cards; wrong ones penalize.
When your hand value is (probably) lowest, CALL_CABO at the end of your action instead of ending normally. Everyone else gets one final turn, then hands reveal; lowest total wins, caller ties/loses are punished in scoring.`,
  pairone: `PAIR ONE — a public memory game. One full deck (52 cards) fills a fixed grid, all face down. Positions never move; collected pairs leave permanent gaps.
On your turn flip any two grid cards (everyone sees them). If ranks match you COLLECT the pair and immediately flip again (same turn continues). If they don't match, both flip back and your turn ends.
Round ends when the grid is empty; MOST pairs collected wins (ties shared). Perfect memory of every flip ever shown wins games.`,
  seep: `SEEP — a 2v2 partnership fishing game (your partner sits across the table; teams = seat parity). 52-card deck, 4 cards dealt to each player plus 4 face-up on the table, replenished in batches when all hands empty.
On your turn play ONE card with an intent:
 - CAPTURE: your card's value equals a single table card, OR equals the sum of a set of table cards — take them all. If you CAN capture you MUST (laying down or building is then illegal).
 - CAPTURE_HOUSE: take a whole face-up house ("build") by playing a card of its total.
 - BUILD: your card + a set of table cards totals T (2..13) and you hold ANOTHER card of T — the set + your card become a face-up house of T owned by your team. Only your team may raise it (add a card of T while keeping another T behind); anyone may capture it.
 - LAY_DOWN: place the card on the table (only legal when nothing can be captured).
Sweeping the ENTIRE table with one play pays +50. Deal ends when the third batch is exhausted: leftover table cards go to the team that captured last, houses go to their owners.
Scoring: spades are worth pip value (faces 10), other aces 5 — 100 points in the deck; highest team total wins the deal.`,
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
  else if (v.phase === 'TRANSFER_PENDING') lines.push('transfer_in_progress: another player owes a card, but flushes remain open');
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
  if (view.gameId === 'cabo') return serializeCaboView(view, selfId);
  if (view.gameId === 'seep') return serializeSeepView(view, selfId);
  return serializePairOneView(view, selfId);
}

export function serializeSeepView(v: SeepPlayerView, selfId: string): string {
  const lines: string[] = [];
  lines.push(`phase=${v.phase} deck=${v.deckCount} batches_remaining=${v.batchesRemaining}`);
  lines.push(`your_team=${v.myTeam} team_points=${v.teamPoints[0]}(team0) vs ${v.teamPoints[1]}(team1) sweeps=${v.sweeps[0]}/${v.sweeps[1]}`);
  const names = new Map(v.players.map((p) => [p.id, p.name]));
  lines.push(`table=[${v.tableLoose.map((c) => cardLabel(v, c.id)).join(' ') || 'empty'}]`);
  for (const h of v.houses) {
    lines.push(
      `house=${h.total} owner=team${h.ownerTeam} cards=[${h.cards.map((c) => cardLabel(v, c.id)).join(' ')}]`,
    );
  }
  for (const p of v.players) {
    const team = v.teams[0].includes(p.id) ? 0 : 1;
    if (p.id === selfId) {
      const hand = (v.handCardIds[p.id] ?? []).map((id) => cardLabel(v, id)).join(' ');
      lines.push(`> YOU (${p.id}, team${team}) hand=[${hand}]`);
    } else {
      lines.push(`  ${names.get(p.id) ?? p.id} (${p.id}, team${team}) holds ${p.cardCount} cards, captured=${(v.captures[p.id] ?? []).length}`);
    }
  }
  const recent = v.events.slice(-6).map((e) => {
    const pid = e.payload?.playerId;
    return `${e.type.toLowerCase()}${pid ? `(${names.get(String(pid)) ?? String(pid)})` : ''}`;
  });
  if (recent.length > 0) lines.push('recent_events=' + recent.join(','));
  return lines.join('\n');
}
