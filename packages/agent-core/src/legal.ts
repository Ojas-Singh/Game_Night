/**
 * Legal-action enumeration from a player VIEW (never engine state).
 *
 * Agents only ever see filtered views, so candidate actions must be derived
 * from exactly what a human client sees. The final authority is always an
 * engine (`validateAction`) — hosts validate before applying, so enumerators
 * may over-approximate slightly but must never MISS a legal action.
 */

import type { CaboPlayerView, CaboAction } from '@game-night/engine-cabo';
import type { PairOnePlayerView, PairOneAction } from '@game-night/engine-pairone';
import type { SeepPlayerView, SeepAction } from '@game-night/engine-seep';
import { captureValue } from '@game-night/engine-seep';
import type { AnyGameView, AnyGameAction } from './types.js';

const isRealCard = (id: string): boolean =>
  !id.startsWith('__slot__') && !id.startsWith('__empty__');

/** Combos of k indexes out of 0..n-1 (n is tiny: hands ≤ ~8 cards). */
function indexCombinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const rec = (start: number, acc: number[]): void => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < n; i++) rec(i + 1, [...acc, i]);
  };
  rec(0, []);
  return out;
}

function caboActions(
  view: CaboPlayerView,
  selfId: string,
  opts: { initialPeekCards?: number },
): AnyGameAction[] {
  const me = (id: string) => ({ playerId: id });
  const ownIds = (view.handCardIds[selfId] ?? []).filter(isRealCard);
  const others = view.players.filter((p) => p.id !== selfId);
  const acts: AnyGameAction[] = [];

  // Flushes are legal interrupts in almost every live phase. Only enumerate
  // KNOWN matches — flushing blind is a gamble bots/heuristics can construct
  // explicitly if they want it.
  const topRank = view.discardTopRank;
  if (
    topRank != null &&
    view.phase !== 'INITIAL_PEEK' &&
    view.phase !== 'ROUND_REVEAL' &&
    view.phase !== 'ROUND_COMPLETE'
  ) {
    const matches = ownIds.filter((id) => view.knownCards[id]?.rank === topRank);
    for (const id of matches) acts.push({ type: 'FLUSH_OWN', ...me(selfId), cardIds: [id] });
    if (matches.length >= 2) {
      acts.push({ type: 'FLUSH_OWN', ...me(selfId), cardIds: [matches[0]!, matches[1]!] });
    }
    for (const o of others) {
      for (const id of view.handCardIds[o.id] ?? []) {
        if (!isRealCard(id)) continue;
        if (view.knownCards[id]?.rank === topRank) {
          acts.push({ type: 'FLUSH_OTHER', ...me(selfId), targetPlayerId: o.id, cardId: id });
        }
      }
    }
  }

  switch (view.phase) {
    case 'INITIAL_PEEK': {
      if (!view.needsInitialPeek) break;
      const handSize = (view.handCardIds[selfId] ?? []).length;
      const k = opts.initialPeekCards ?? 2;
      for (const combo of indexCombinations(handSize, k)) {
        acts.push({ type: 'PEEK_STARTING', ...me(selfId), cardIndexes: combo });
      }
      break;
    }
    case 'TURN_DRAW':
      acts.push({ type: 'DRAW', ...me(selfId) });
      break;
    case 'DRAW_DECISION': {
      const ids = view.handCardIds[selfId] ?? [];
      for (let i = 0; i < ids.length; i++) {
        if (isRealCard(ids[i]!)) acts.push({ type: 'KEEP_DRAWN', ...me(selfId), handIndex: i });
      }
      acts.push({ type: 'DISCARD_DRAWN', ...me(selfId) });
      break;
    }
    case 'POWER_PENDING': {
      const p = view.pendingPower;
      if (!p) break;
      if (p.power === 'PEEK_OWN') {
        for (const id of ownIds) {
          acts.push({ type: 'POWER_APPLY', ...me(selfId), payload: { power: 'PEEK_OWN', cardId: id } });
        }
      } else if (p.power === 'PEEK_OTHER') {
        for (const o of others) {
          for (const id of view.handCardIds[o.id] ?? []) {
            if (!isRealCard(id)) continue;
            acts.push({
              type: 'POWER_APPLY',
              ...me(selfId),
              payload: { power: 'PEEK_OTHER', targetPlayerId: o.id, cardId: id },
            });
          }
        }
      } else if (p.power === 'BLIND_SWAP') {
        for (const own of ownIds) {
          for (const o of others) {
            for (const theirs of view.handCardIds[o.id] ?? []) {
              if (!isRealCard(theirs)) continue;
              acts.push({
                type: 'POWER_APPLY',
                ...me(selfId),
                payload: { power: 'BLIND_SWAP', ownCardId: own, targetPlayerId: o.id, targetCardId: theirs },
              });
            }
          }
        }
      }
      break;
    }
    case 'TRANSFER_PENDING': {
      if (view.pendingTransfer) {
        for (const id of ownIds) acts.push({ type: 'TRANSFER_CARD', ...me(selfId), cardId: id });
      }
      break;
    }
    case 'TURN_END': {
      acts.push({ type: 'END_TURN', ...me(selfId) });
      if (!view.cabo) acts.push({ type: 'CALL_CABO', ...me(selfId) });
      break;
    }
    default:
      break; // ROUND_REVEAL / ROUND_COMPLETE: nothing to do
  }
  return acts;
}

function pairOneActions(view: PairOnePlayerView, selfId: string): AnyGameAction[] {
  if (view.phase !== 'TURN') return [];
  const me = { playerId: selfId };
  const acts: AnyGameAction[] = [];
  const faceUp = new Set(view.faceUpCardIds);
  for (const id of view.gridCardIds) {
    if (!isRealCard(id) || faceUp.has(id)) continue;
    acts.push({ type: 'FLIP_CARD', ...me, cardId: id });
  }
  return acts;
}

/** Subset sizes above this are never worth enumerating (table stays small). */
const SEEP_MAX_SET = 4;

function seepActions(view: SeepPlayerView, selfId: string): AnyGameAction[] {
  const me = { playerId: selfId };
  const acts: AnyGameAction[] = [];

  // The opener announces a number 9–13 they hold.
  if (view.phase === 'ANNOUNCE') {
    for (const id of view.handCardIds[selfId] ?? []) {
      const card = view.knownCards[id];
      if (!card) continue;
      const v = captureValue(card);
      if (v >= 9 && v <= 13) acts.push({ type: 'ANNOUNCE', ...me, value: v });
    }
    return acts;
  }
  if (view.phase !== 'TURN_PLAY') return [];

  const handIds = (view.handCardIds[selfId] ?? []).filter((id) => view.knownCards[id]);
  const loose = view.tableLoose;
  const n = Math.min(loose.length, SEEP_MAX_SET);

  // Hand values (own hand is always known to its owner).
  const handValues = handIds.map((id) => captureValue(view.knownCards[id]!));
  const bid = view.bid;
  const openingPlay = view.players.find((p) => p.isCurrentTurn)?.id === selfId && view.playsMade === 0;

  for (let i = 0; i < handIds.length; i++) {
    const cardId = handIds[i]!;
    const v = handValues[i]!;
    const rest = handValues.filter((_, j) => j !== i);
    // On the opening play every move must involve the announced number —
    // the per-action gates below enforce that (builds of the bid total may
    // use a non-bid card).
    const mustInvolveBid = openingPlay && bid !== null;

    // Lay down (over-approximation: the engine enforces must-capture).
    if (!mustInvolveBid || v === bid) {
      acts.push({ type: 'PLAY_CARD', ...me, cardId, intent: { kind: 'LAY_DOWN' } });
    }

    // Capture loose subsets summing to v (must be v === bid on the opener).
    if (!mustInvolveBid || v === bid) {
      for (let k = 1; k <= n; k++) {
        for (const combo of indexCombinations(loose.length, k)) {
          const ids = combo.map((idx) => loose[idx]!.id);
          const sum = combo.reduce((acc, idx) => acc + captureValue(loose[idx]!), 0);
          if (sum !== v) continue;
          acts.push({ type: 'PLAY_CARD', ...me, cardId, intent: { kind: 'CAPTURE', tableCardIds: ids, houseIds: [] } });
        }
      }
    }
    // Capture houses of the same total (loose cards optional).
    for (const house of view.houses) {
      if (house.total === v && (!mustInvolveBid || v === bid)) {
        acts.push({ type: 'PLAY_CARD', ...me, cardId, intent: { kind: 'CAPTURE', tableCardIds: [], houseIds: [house.id] } });
      }
      // Add another complete set to an own-team house: played card alone or
      // with loose cards completing the house total.
      if (house.ownerTeam === view.myTeam) {
        const need = house.total - v;
        if (need === 0) {
          acts.push({ type: 'PLAY_CARD', ...me, cardId, intent: { kind: 'ADD_TO_HOUSE', houseId: house.id, tableCardIds: [] } });
        } else if (need > 0) {
          for (let k = 1; k <= n; k++) {
            for (const combo of indexCombinations(loose.length, k)) {
              const sum = combo.reduce((acc, idx) => acc + captureValue(loose[idx]!), 0);
              if (sum !== need) continue;
              acts.push({
                type: 'PLAY_CARD',
                ...me,
                cardId,
                intent: { kind: 'ADD_TO_HOUSE', houseId: house.id, tableCardIds: combo.map((idx) => loose[idx]!.id) },
              });
            }
          }
        }
      }
      // Break an opponent's kachcha ghar upward: total + v ≤ 13, hold the new total.
      if (!house.pakka && house.ownerTeam !== view.myTeam && house.total + v <= 13 && rest.includes(house.total + v)) {
        acts.push({ type: 'PLAY_CARD', ...me, cardId, intent: { kind: 'BREAK_HOUSE', houseId: house.id } });
      }
    }
    // Builds: card + subset totals another held value, 9–13.
    if (view.myTeam !== null) {
      for (let k = 1; k <= n; k++) {
        for (const combo of indexCombinations(loose.length, k)) {
          const total = v + combo.reduce((acc, idx) => acc + captureValue(loose[idx]!), 0);
          if (total < 9 || total > 13) continue;
          if (mustInvolveBid && total !== bid) continue;
          if (!rest.includes(total)) continue;
          acts.push({
            type: 'PLAY_CARD',
            ...me,
            cardId,
            intent: { kind: 'BUILD', tableCardIds: combo.map((idx) => loose[idx]!.id), total },
          });
        }
      }
    }
  }
  return acts;
}

export interface EnumerateOpts {
  /** House-rule hint for the initial peek count (default 2). */
  initialPeekCards?: number;
}

/** All actions worth considering for `selfId` right now. May over-approximate. */
export function enumerateLegalActions(
  view: AnyGameView,
  selfId: string,
  opts: EnumerateOpts = {},
): AnyGameAction[] {
  if (view.gameId === 'cabo') return caboActions(view, selfId, opts);
  if (view.gameId === 'seep') return seepActions(view, selfId);
  return pairOneActions(view, selfId);
}

export { isRealCard };
