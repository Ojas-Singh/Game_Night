/**
 * Canonical legal-move enumeration for Seep.
 *
 * This is the SINGLE source of truth for what a player may do — the web UI
 * and the agents both consume it, so rule logic can never drift between
 * clients again. Everything is derived purely from a player VIEW (no engine
 * internals, no hidden information), and every returned action must pass
 * `engine.validateAction` in the same state (property-tested both ways).
 *
 * Enumeration is exhaustive: loose-card subsets are pruned only when the
 * partial sum already exceeds the largest useful total (13), so there is no
 * arbitrary "max set size".
 */

import { captureValue, maximalCaptureAlternatives, type SeepTeam } from './rules.js';
import type { SeepAction, SeepPlayIntent } from './types.js';
import type { SeepPlayerView } from './views.js';

const MIN_HOUSE = 9;
const MAX_HOUSE = 13;

/**
 * All legal actions for `playerId` in the given view, in a stable order:
 * ANNOUNCE candidates first, then per hand card LAY → CAPTURE → BUILD →
 * ADD → BREAK.
 */
export function enumerateSeepActions(view: SeepPlayerView, playerId: string): SeepAction[] {
  if (view.phase === 'ANNOUNCE') {
    if (view.bidderId !== playerId) return [];
    const out: SeepAction[] = [];
    const values = new Set<number>();
    for (const id of view.handCardIds[playerId] ?? []) {
      const card = view.knownCards[id];
      if (card && card.rank >= MIN_HOUSE && card.rank <= MAX_HOUSE) values.add(card.rank);
    }
    for (const value of [...values].sort((a, b) => a - b)) {
      out.push({ type: 'ANNOUNCE', playerId, value });
    }
    return out;
  }
  if (view.phase !== 'TURN_PLAY') return [];
  const current = view.players.find((p) => p.isCurrentTurn);
  if (!current || current.id !== playerId) return [];

  const handIds = (view.handCardIds[playerId] ?? []).filter((id) => view.knownCards[id]);
  const loose = view.tableLoose;
  const myTeam = view.myTeam;
  if (myTeam === null) return [];
  const opening = view.playsMade === 0;
  const bid = view.bid;
  const out: SeepAction[] = [];

  for (const cardId of handIds) {
    const card = view.knownCards[cardId]!;
    const v = captureValue(card);
    const restIds = handIds.filter((id) => id !== cardId);
    const restValues = restIds.map((id) => captureValue(view.knownCards[id]!));
    const holdsBehind = (total: number): boolean => restValues.includes(total);

    // ---- Capture availability of THIS card (drives LAY legality) --------
    const matchingHouses = view.houses.filter((h) => h.total === v);
    const alternatives = maximalCaptureAlternatives(loose, v);
    const canCapture = matchingHouses.length > 0 || alternatives.length > 0;

    // ---- LAY -------------------------------------------------------------
    if (!canCapture && (!opening || v === bid)) {
      out.push({ type: 'PLAY_CARD', playerId, cardId, intent: { kind: 'LAY_DOWN' } });
    }

    // ---- CAPTURE ----------------------------------------------------------
    if (!opening || v === bid) {
      if (matchingHouses.length > 0 || alternatives.length > 0) {
        const houseIds = matchingHouses.map((h) => h.id);
        if (alternatives.length === 0) {
          pushCapture(out, playerId, cardId, [], houseIds, view);
        } else {
          for (const groups of alternatives) {
            const ids = groups.flat().map((i) => loose[i]!.id);
            pushCapture(out, playerId, cardId, ids, houseIds, view);
          }
        }
      }
    }

    // ---- BUILD ------------------------------------------------------------
    for (const subset of looseSubsets(loose, 1, MAX_HOUSE * 2 - v)) {
      const sum = v + subset.sum;
      for (let total = MIN_HOUSE; total <= MAX_HOUSE; total++) {
        // the pile must form complete copies of the house total
        if (sum < total || sum % total !== 0) continue;
        if (opening && total !== bid) continue;
        const existing = view.houses.find((h) => h.total === total);
        // establishing (or cementing an opponent house) needs a backing card;
        // merging into a house my team already owns does not
        if ((!existing || existing.ownerByTeam[myTeam as SeepTeam] === undefined) && !holdsBehind(total)) {
          continue;
        }
        if (!retentionOk(view, playerId, restIds, [])) continue;
        out.push({
          type: 'PLAY_CARD',
          playerId,
          cardId,
          intent: { kind: 'BUILD', tableCardIds: subset.ids, total },
        });
      }
    }

    // ---- ADD (cement) -------------------------------------------------------
    // NOTE: the house SURVIVES a cement — it still demands retention from
    // its owners (an owner needs one card to play and one to keep), so it
    // is NOT excluded from the retention simulation below.
    for (const house of view.houses) {
      const need = house.total - v;
      if (need < 0) continue;
      const mineOwns = house.ownerByTeam[myTeam as SeepTeam] !== undefined;
      if (!mineOwns && !holdsBehind(house.total)) continue; // opponent cement → retention
      if (need === 0) {
        if (!retentionOk(view, playerId, restIds, [])) continue;
        out.push({
          type: 'PLAY_CARD',
          playerId,
          cardId,
          intent: { kind: 'ADD_TO_HOUSE', houseId: house.id, tableCardIds: [] },
        });
      } else {
        for (const subset of looseSubsets(loose, need, need)) {
          if (!retentionOk(view, playerId, restIds, [])) continue;
          out.push({
            type: 'PLAY_CARD',
            playerId,
            cardId,
            intent: { kind: 'ADD_TO_HOUSE', houseId: house.id, tableCardIds: subset.ids },
          });
        }
      }
    }

    // ---- BREAK --------------------------------------------------------------
    for (const house of view.houses) {
      const newTotal = house.total + v;
      if (newTotal > MAX_HOUSE) continue;
      if (house.pakka) continue;
      if (myTeam !== null && house.ownerByTeam[myTeam as SeepTeam] === playerId) continue; // own ghar
      if (!holdsBehind(newTotal)) continue;
      if (!retentionOk(view, playerId, restIds, [house.id])) continue;
      out.push({
        type: 'PLAY_CARD',
        playerId,
        cardId,
        intent: { kind: 'BREAK_HOUSE', houseId: house.id },
      });
    }
  }
  return out;
}

function pushCapture(
  out: SeepAction[],
  playerId: string,
  cardId: string,
  tableCardIds: string[],
  houseIds: string[],
  view: SeepPlayerView,
): void {
  if (!retentionOk(view, playerId, (view.handCardIds[playerId] ?? []).filter((id) => id !== cardId), houseIds)) return;
  out.push({
    type: 'PLAY_CARD',
    playerId,
    cardId,
    intent: { kind: 'CAPTURE', tableCardIds, houseIds },
  });
}

/**
 * Retention simulation: after this play, every house I still own must have
 * a matching card in my hand. Houses captured in the same play are exempt;
 * other owners' hands are untouched so only my own duties can newly fail.
 * Last-card relaxation: on my final card my own retention cannot block me
 * (the deal would otherwise deadlock).
 */
function retentionOk(
  view: SeepPlayerView,
  playerId: string,
  handAfterIds: string[],
  capturedHouseIds: string[],
): boolean {
  const captured = new Set(capturedHouseIds);
  if (handAfterIds.length === 0) return true;
  const handValues = handAfterIds.map((id) => captureValue(view.knownCards[id]!));
  for (const house of view.houses) {
    if (captured.has(house.id)) continue;
    if (house.owners.includes(playerId)) {
      if (!handValues.includes(house.total)) return false;
    }
  }
  return true;
}

/**
 * All distinct loose-card subsets whose sum lies in [min, max], with sums.
 * Prunes as soon as the partial sum exceeds `max` — exhaustive without a
 * fixed subset-size cap.
 */
export function looseSubsets(
  loose: SeepPlayerView['tableLoose'],
  min: number,
  max: number,
): Array<{ ids: string[]; sum: number }> {
  const out: Array<{ ids: string[]; sum: number }> = [];
  if (max < 1) return out;
  const rec = (start: number, ids: string[], sum: number): void => {
    if (sum >= min && sum <= max && ids.length > 0) {
      out.push({ ids: [...ids], sum });
    }
    for (let j = start; j < loose.length; j++) {
      const next = sum + captureValue(loose[j]!);
      if (next > max) continue;
      ids.push(loose[j]!.id);
      rec(j + 1, ids, next);
      ids.pop();
    }
  };
  rec(0, [], 0);
  return out;
}

/**
 * The maximal capture alternatives for one hand card (choice chips for the
 * UI): every legal grouping of loose cards that must accompany the houses.
 */
export function captureAlternativesFor(
  view: SeepPlayerView,
  cardId: string,
): Array<{ tableCardIds: string[]; houseIds: string[] }> {
  const card = view.knownCards[cardId];
  if (!card || view.phase !== 'TURN_PLAY') return [];
  const v = captureValue(card);
  if (view.playsMade === 0 && v !== view.bid) return [];
  const matchingHouses = view.houses.filter((h) => h.total === v).map((h) => h.id);
  const alternatives = maximalCaptureAlternatives(view.tableLoose, v);
  if (matchingHouses.length === 0 && alternatives.length === 0) return [];
  if (alternatives.length === 0) {
    return [{ tableCardIds: [], houseIds: matchingHouses }];
  }
  return alternatives.map((groups) => ({
    tableCardIds: groups.flat().map((i) => view.tableLoose[i]!.id),
    houseIds: matchingHouses,
  }));
}

export type { SeepPlayIntent };
