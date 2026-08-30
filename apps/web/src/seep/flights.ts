/**
 * Card-flight derivation for Seep: translate the event-log delta between two
 * views into the same CardFlight stream the Cabo table animates. Pure —
 * unit-tested against hand-built views.
 */

import type { CardFlight } from '../useRoom.js';
import type { SeepPlayerView } from '@seep/views.js';

export function collectSeepFlights(
  prev: SeepPlayerView,
  next: SeepPlayerView,
  myPlayerId?: string | null,
): CardFlight[] {
  const seen = new Set(prev.events.map((e) => e.seq));
  const out: CardFlight[] = [];
  for (const ev of next.events) {
    if (seen.has(ev.seq)) continue;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const actorId = typeof p.playerId === 'string' ? p.playerId : ev.playerId;

    switch (ev.type) {
      case 'PLAY_LAY': {
        const cardId = typeof p.cardId === 'string' ? p.cardId : undefined;
        out.push({
          id: `PLAY_LAY-${ev.seq}`,
          seq: ev.seq,
          fromPlayerId: String(actorId ?? ''),
          fromCardId: cardId,
          toDiscard: true,
          toCardId: cardId, // lands exactly on its new table element
          rank: 0,
        });
        break;
      }
      case 'PLAY_CAPTURE': {
        // Every captured card glides from its table slot into the capturer's
        // pile (seat anchor); the played card flies with it.
        const captured = Array.isArray(p.capturedIds)
          ? (p.capturedIds as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        for (const cid of captured) {
          out.push({
            id: `PLAY_CAPTURE-${ev.seq}-${cid}`,
            seq: ev.seq,
            fromPlayerId: String(actorId ?? ''),
            fromCardId: cid,
            toDiscard: false,
            toPlayerId: actorId,
            rank: 0,
          });
        }
        if (typeof p.cardId === 'string') {
          out.push({
            id: `PLAY_CAPTURE-${ev.seq}-played`,
            seq: ev.seq,
            fromPlayerId: String(actorId ?? ''),
            fromCardId: p.cardId,
            toDiscard: false,
            toPlayerId: actorId === myPlayerId ? undefined : actorId,
            rank: 0,
          });
        }
        break;
      }
      case 'PLAY_BUILD': {
        // The played card + joined cards land on the new house stack.
        const cardId = typeof p.cardId === 'string' ? p.cardId : undefined;
        out.push({
          id: `PLAY_BUILD-${ev.seq}`,
          seq: ev.seq,
          fromPlayerId: String(actorId ?? ''),
          fromCardId: cardId,
          toDiscard: true,
          toCardId: typeof p.houseId === 'string' ? p.houseId : undefined,
          rank: 0,
        });
        break;
      }
      case 'PLAY_RAISE': {
        const cardId = typeof p.cardId === 'string' ? p.cardId : undefined;
        out.push({
          id: `PLAY_RAISE-${ev.seq}`,
          seq: ev.seq,
          fromPlayerId: String(actorId ?? ''),
          fromCardId: cardId,
          toDiscard: true,
          toCardId: typeof p.houseId === 'string' ? p.houseId : undefined,
          rank: 0,
        });
        break;
      }
      case 'BATCH_DEALT': {
        // A fresh batch flies from the deck to every seat (face-down).
        if (prev.batchesRemaining <= next.batchesRemaining) break;
        for (const player of next.players) {
          out.push({
            id: `BATCH_DEALT-${ev.seq}-${player.id}`,
            seq: ev.seq,
            fromPlayerId: 'deck',
            toDiscard: false,
            toPlayerId: player.id === myPlayerId ? undefined : player.id,
            rank: 0,
          });
        }
        break;
      }
      default:
        break; // ROUND_*/TURN_STARTED/SEEP_SWEEP: no card movement
    }
  }
  return out;
}
