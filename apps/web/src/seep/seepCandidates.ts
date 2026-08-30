/**
 * Pure client-side intent computation for Seep (Punjabi rules).
 *
 * Everything here derives from the filtered player VIEW (public zones + own
 * hand) — identical information to what the agents see. The server remains
 * authoritative: candidates only pre-compute what the UI offers; the engine
 * re-validates every action.
 */

import { captureValue } from '@seep/rules.js';
import type { SeepPlayerView } from '@seep/views.js';

export interface SeepCandidateIntents {
  cardId: string;
  /**
   * Legal loose-card capture sets. Each set groups entirely into the card's
   * value (several groups at once is one capture: A+7, 3+5 and a loose 8).
   */
  captures: string[][];
  /** Houses capturable by playing this card (total === value). */
  capturableHouseIds: string[];
  /** Legal builds: card + set totals `total` (9–13), backed in hand. */
  builds: Array<{ tableCardIds: string[]; total: number }>;
  /** Own-team houses this card can extend: alone or with a set completing the total. */
  addableHouses: Array<{ houseId: string; tableCardIds: string[] }>;
  /** Opponent kachcha ghars this card can break upward (new total held). */
  breakableHouses: Array<{ houseId: string; newTotal: number }>;
  /** True when laying down would be legal (no capture available). */
  canLay: boolean;
}

/** Maximum subset size the UI enumerates (the table stays small in practice). */
const MAX_SET = 5;

/** All index combinations of size k out of n. */
export function combos(n: number, k: number): number[][] {
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

/** Subset sums of the loose table cards (by size), for grouping checks. */
function subsetsBySize(loose: SeepPlayerView['tableLoose'], maxSize: number): Array<{ ids: string[]; sum: number }> {
  const out: Array<{ ids: string[]; sum: number }> = [];
  const maxK = Math.min(loose.length, maxSize);
  for (let k = 1; k <= maxK; k++) {
    for (const comboIdx of combos(loose.length, k)) {
      let sum = 0;
      const ids: string[] = [];
      for (const i of comboIdx) {
        sum += captureValue(loose[i]!);
        ids.push(loose[i]!.id);
      }
      out.push({ ids, sum });
    }
  }
  return out;
}

/**
 * True when `ids` split into groups that each sum to `v` — the multi-group
 * capture rule (with an 8: A+7, 3+5 and a loose 8 together).
 */
export function groupsInto(loose: SeepPlayerView['tableLoose'], ids: string[], v: number): boolean {
  const chosen = loose.filter((x) => ids.includes(x.id));
  if (chosen.length === 0) return false;
  const total = chosen.reduce((sum, x) => sum + captureValue(x), 0);
  if (total % v !== 0) return false;
  const groups = total / v;
  if (groups === 1) return total === v;
  // Partition check: repeatedly peel any subset summing to v.
  const values = chosen.map((x) => captureValue(x));
  const used = new Array<boolean>(values.length).fill(false);
  const peel = (): boolean => {
    const fill = (from: number, need: number): boolean => {
      if (need === 0) return true;
      for (let j = from; j < values.length; j++) {
        if (used[j] || values[j]! > need) continue;
        used[j] = true;
        if (fill(j + 1, need - values[j]!)) return true;
        used[j] = false;
      }
      return false;
    };
    for (let j = 0; j < values.length; j++) {
      if (used[j]) continue;
      used[j] = true;
      if (fill(j + 1, v - values[j]!)) return true;
      used[j] = false;
    }
    return false;
  };
  for (let g = 0; g < groups; g++) {
    if (!peel()) return false;
  }
  return true;
}

/** Compute every intent the given hand card could legally express. */
export function intentsForCard(
  view: SeepPlayerView,
  cardId: string,
  selfId: string,
): SeepCandidateIntents {
  const card = view.knownCards[cardId];
  const empty: SeepCandidateIntents = {
    cardId,
    captures: [],
    capturableHouseIds: [],
    builds: [],
    addableHouses: [],
    breakableHouses: [],
    canLay: false,
  };
  if (!card || !(view.handCardIds[selfId] ?? []).includes(cardId)) return empty;
  if (view.phase !== 'TURN_PLAY') return empty;
  const v = captureValue(card);
  const bid = view.bid;
  const opening = view.playsMade === 0;
  // On the opening play everything must involve the announced number.
  if (opening && bid === null) return empty;

  const loose = view.tableLoose;
  const subsets = subsetsBySize(loose, MAX_SET);

  // Loose captures: sets summing to v, plus multi-group sets (total a
  // multiple of v that actually partitions into v-groups) — only the bid
  // value on the opener.
  const captures: string[][] = [];
  if (!opening || v === bid) {
    const seen = new Set<string>();
    for (const { ids, sum } of subsets) {
      if (sum !== v && !(sum > v && sum % v === 0 && groupsInto(loose, ids, v))) continue;
      const key = [...ids].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      captures.push(ids);
    }
  }

  // Houses matching the value (same bid gate on the opening play).
  const capturableHouseIds =
    !opening || v === bid ? view.houses.filter((h) => h.total === v).map((h) => h.id) : [];

  // Backing: other cards of the target value still in my hand.
  const backingCount = (target: number) =>
    (view.handCardIds[selfId] ?? [])
      .filter((id) => id !== cardId && view.knownCards[id]?.rank === target).length;

  // Own-team house extensions: card alone (need === 0) or with a set that
  // completes the total. Retention binds the OWNER only — a partner may play
  // their last matching card; the owner must keep one behind.
  const addableHouses: Array<{ houseId: string; tableCardIds: string[] }> = [];
  for (const house of view.houses) {
    if (house.ownerTeam !== view.myTeam) continue;
    if (opening) continue; // no houses exist on the opening play anyway
    const need = house.total - v;
    const mustKeepBacking = house.ownerId === selfId;
    if (need === 0) {
      if (mustKeepBacking && backingCount(house.total) < 1) continue;
      addableHouses.push({ houseId: house.id, tableCardIds: [] });
    } else if (need > 0) {
      for (const { ids, sum } of subsets) {
        if (sum !== need) continue;
        addableHouses.push({ houseId: house.id, tableCardIds: ids });
        break; // one completion per house is enough for the UI
      }
    }
  }

  // Breaks: opponent (non-own) kachcha ghars, total + v ≤ 13, new total held.
  const breakableHouses: Array<{ houseId: string; newTotal: number }> = [];
  for (const house of view.houses) {
    if (house.pakka || house.ownerTeam === view.myTeam) continue;
    const newTotal = house.total + v;
    if (newTotal > 13) continue;
    if (backingCount(newTotal) < 1) continue;
    breakableHouses.push({ houseId: house.id, newTotal });
  }

  // Builds: card + set totals another held value, 9–13 (the bid on the opener).
  const builds: Array<{ tableCardIds: string[]; total: number }> = [];
  for (const { ids, sum } of subsets) {
    const total = sum + v;
    if (total < 9 || total > 13) continue;
    if (opening && total !== bid) continue;
    if (backingCount(total) < 1) continue;
    builds.push({ tableCardIds: ids, total });
  }

  const hasCapture = captures.length > 0 || capturableHouseIds.length > 0;
  // Must-capture: laying, building and breaking are out entirely. ADDING to
  // an own-team ghar survives a HOUSE capture (that's how you pakka it) —
  // only a loose capture blocks it.
  const hasLooseCapture = captures.length > 0;
  return {
    cardId,
    captures,
    capturableHouseIds,
    builds: hasCapture ? [] : builds,
    addableHouses: hasLooseCapture ? [] : addableHouses,
    breakableHouses: hasCapture ? [] : breakableHouses,
    canLay: !hasCapture && (!opening || v === bid),
  };
}

/** All of my candidate intents, keyed by hand card id. */
export function allIntents(view: SeepPlayerView, selfId: string): Record<string, SeepCandidateIntents> {
  const out: Record<string, SeepCandidateIntents> = {};
  for (const id of view.handCardIds[selfId] ?? []) {
    if (!view.knownCards[id]) continue;
    out[id] = intentsForCard(view, id, selfId);
  }
  return out;
}

/** Biddable announce values (9–13) the given player actually holds. */
export function biddableValues(view: SeepPlayerView, selfId: string): number[] {
  const values = new Set<number>();
  for (const id of view.handCardIds[selfId] ?? []) {
    const card = view.knownCards[id];
    if (card && card.rank >= 9 && card.rank <= 13) values.add(card.rank);
  }
  return [...values].sort((a, b) => b - a);
}
