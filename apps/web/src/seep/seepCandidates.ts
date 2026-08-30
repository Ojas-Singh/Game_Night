/**
 * Thin adapter over the ENGINE's canonical legal-action enumerator.
 *
 * There is exactly ONE source of truth for what is legal in Seep —
 * `enumerateSeepActions` in @seep/engine — and this file only reshapes its
 * output into the per-card intent groups the table UI renders. The server
 * re-validates every action; nothing here decides rules.
 */

import { captureValue, enumerateSeepActions, type SeepAction, type SeepPlayerView } from '@seep/index.js';

/** One complete, engine-legal capture play for a hand card. */
export interface SeepCaptureChoice {
  /** The maximal loose-card collection (may be empty when only a ghar matches). */
  tableCardIds: string[];
  /** Every ghar the play takes (all matching ghars are compulsory). */
  houseIds: string[];
}

export interface SeepCandidateIntents {
  cardId: string;
  /**
   * Every distinct capture play the engine enumerated for this card —
   * overlapping loose alternatives appear as separate choices.
   */
  captures: SeepCaptureChoice[];
  /** Houses capturable by playing this card (total === value). */
  capturableHouseIds: string[];
  /** Legal builds: card + set totals `total` (9–13), backed in hand. */
  builds: Array<{ tableCardIds: string[]; total: number }>;
  /** Houses this card can cement: alone or with a set completing the total. */
  addableHouses: Array<{ houseId: string; tableCardIds: string[] }>;
  /** Kachcha ghars this card can break upward (new total held). */
  breakableHouses: Array<{ houseId: string; newTotal: number }>;
  /** True when laying down would be legal (the card takes nothing). */
  canLay: boolean;
}

const emptyIntents = (cardId: string): SeepCandidateIntents => ({
  cardId,
  captures: [],
  capturableHouseIds: [],
  builds: [],
  addableHouses: [],
  breakableHouses: [],
  canLay: false,
});

/** Group the engine's enumerated actions by the played hand card. */
export function intentsForCard(
  view: SeepPlayerView,
  cardId: string,
  selfId: string,
): SeepCandidateIntents {
  if (!(view.handCardIds[selfId] ?? []).includes(cardId)) return emptyIntents(cardId);
  const intents = emptyIntents(cardId);
  const captureSeen = new Set<string>();
  const houseSet = new Set<string>();
  const buildSeen = new Set<string>();
  const addSeen = new Set<string>();
  const breakSeen = new Set<string>();

  for (const action of enumerateSeepActions(view, selfId)) {
    if (action.type !== 'PLAY_CARD' || action.cardId !== cardId) continue;
    const intent = action.intent;
    switch (intent.kind) {
      case 'LAY_DOWN':
        intents.canLay = true;
        break;
      case 'CAPTURE': {
        const key = `${intent.houseIds.slice().sort().join('|')}#${[...intent.tableCardIds].sort().join('|')}`;
        if (!captureSeen.has(key)) {
          captureSeen.add(key);
          intents.captures.push({ tableCardIds: intent.tableCardIds, houseIds: intent.houseIds });
        }
        for (const id of intent.houseIds) houseSet.add(id);
        break;
      }
      case 'BUILD': {
        const key = `${intent.total}:${[...intent.tableCardIds].sort().join('|')}`;
        if (!buildSeen.has(key)) {
          buildSeen.add(key);
          intents.builds.push({ tableCardIds: intent.tableCardIds, total: intent.total });
        }
        break;
      }
      case 'ADD_TO_HOUSE': {
        const key = `${intent.houseId}:${[...intent.tableCardIds].sort().join('|')}`;
        if (!addSeen.has(key)) {
          addSeen.add(key);
          intents.addableHouses.push({ houseId: intent.houseId, tableCardIds: intent.tableCardIds });
        }
        break;
      }
      case 'BREAK_HOUSE': {
        if (!breakSeen.has(intent.houseId)) {
          breakSeen.add(intent.houseId);
          const house = view.houses.find((h) => h.id === intent.houseId);
          intents.breakableHouses.push({
            houseId: intent.houseId,
            newTotal: house ? house.total + captureValue(view.knownCards[cardId]!) : 0,
          });
        }
        break;
      }
    }
  }
  intents.capturableHouseIds = [...houseSet];
  return intents;
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
  for (const action of enumerateSeepActions(view, selfId) as SeepAction[]) {
    if (action.type === 'ANNOUNCE') values.add(action.value);
  }
  return [...values].sort((a, b) => b - a);
}
