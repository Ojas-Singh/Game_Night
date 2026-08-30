/**
 * Pure client-side intent computation for Seep.
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
  /** Legal capture sets: each is a list of table card ids summing to the value. */
  captures: string[][];
  /** Houses capturable by playing this card. */
  capturableHouseIds: string[];
  /** Legal builds with this card: card + set totals `total`, backed in hand. */
  builds: Array<{ tableCardIds: string[]; total: number }>;
  /** Own-team houses this card can raise. */
  raiseHouseIds: string[];
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
    raiseHouseIds: [],
    canLay: false,
  };
  if (!card || !(view.handCardIds[selfId] ?? []).includes(cardId)) return empty;
  const v = captureValue(card);

  const captures: string[][] = [];
  // Single-card match first (the common case).
  for (const t of view.tableLoose) {
    if (captureValue(t) === v) captures.push([t.id]);
  }
  // Subsets (size ≥ 2) summing to the value.
  const loose = view.tableLoose;
  const maxK = Math.min(loose.length, MAX_SET);
  for (let k = 2; k <= maxK; k++) {
    for (const comboIdx of combos(loose.length, k)) {
      let sum = 0;
      const ids: string[] = [];
      for (const i of comboIdx) {
        sum += captureValue(loose[i]!);
        ids.push(loose[i]!.id);
      }
      if (sum === v) captures.push(ids);
    }
  }

  const capturableHouseIds = view.houses.filter((h) => h.total === v).map((h) => h.id);

  // Backing: other cards of the same value still in my hand.
  const backingCount = (target: number) =>
    (view.handCardIds[selfId] ?? [])
      .filter((id) => id !== cardId && view.knownCards[id]?.rank === target).length;

  const builds: Array<{ tableCardIds: string[]; total: number }> = [];
  const raiseHouseIds = view.houses
    .filter((h) => h.ownerTeam === view.myTeam && h.total === v && backingCount(v) >= 1)
    .map((h) => h.id);

  for (let k = 1; k <= maxK; k++) {
    for (const comboIdx of combos(loose.length, k)) {
      let total = v;
      const ids: string[] = [];
      for (const i of comboIdx) {
        total += captureValue(loose[i]!);
        ids.push(loose[i]!.id);
      }
      if (total < 2 || total > 13) continue;
      if (backingCount(total) < 1) continue;
      builds.push({ tableCardIds: ids, total });
    }
  }

  const hasCapture = captures.length > 0 || capturableHouseIds.length > 0;
  return {
    cardId,
    captures,
    capturableHouseIds,
    builds: hasCapture ? [] : builds, // must-capture: builds are illegal then
    raiseHouseIds,
    canLay: !hasCapture,
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
