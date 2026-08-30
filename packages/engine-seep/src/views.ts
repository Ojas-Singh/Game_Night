/**
 * Filtered player views for Seep — what each seat is allowed to know.
 *
 * Information model (contract §Information):
 *  - the floor and house contents are always face up to everyone;
 *  - a team's captured pile is FACE DOWN: only the count is public;
 *  - the cards of the most recent pick-up stay inspectable until the next
 *    player has played, after which they are hidden from everyone;
 *  - at DEAL_COMPLETE / MATCH_COMPLETE everything is counted openly;
 *  - Test Mode (revealAll) sees through all of it (dev aid only).
 */

import type { Card, GameEvent, GamePlayer } from '@game-night/shared';
import type { SeepRules, SeepTeam } from './rules.js';
import { teamOfSeat } from './rules.js';
import { houseCopies, houseIsPakka, type SeepDealResult, type SeepHouse, type SeepState } from './types.js';

export interface SeepHouseView {
  id: string;
  total: number;
  /** Owning player id per team (at least one entry). */
  ownerByTeam: Partial<Record<SeepTeam, string>>;
  /** Flat list of owning player ids (UI convenience). */
  owners: string[];
  /** Complete sets of `total` joined here (derived: Σvalues / total). */
  copies: number;
  /** Cemented (pakka) = copies ≥ 2 — can no longer be broken. */
  pakka: boolean;
  cards: Card[];
}

export interface SeepDealResultView {
  dealNo: number;
  teamScores: { 0: number; 1: number };
  winnerTeam: SeepTeam | null;
  baaziLead: number;
  baazisWon: { 0: number; 1: number };
  baazi: { winnerTeam: SeepTeam; reason: 'lead' | 'minimum-points' } | null;
  leftoverTeam: SeepTeam | null;
}

export interface SeepViewPlayer {
  id: string;
  name: string;
  seat: number;
  /** Cards left in this player's hand. */
  cardCount: number;
  isCurrentTurn: boolean;
}

export interface SeepPlayerView {
  gameId: 'seep';
  revision: number;
  phase: SeepState['phase'];
  players: SeepViewPlayer[];
  /** Only cards this viewer may currently see the face of. */
  knownCards: Record<string, Card>;
  handCardIds: Record<string, string[]>;
  deckCount: number;
  /** Compatibility with the shared table shell (Seep has no discard). */
  discardTop: null;
  events: GameEvent[];
  myTeam: SeepTeam | null;
  teams: { 0: string[]; 1: string[] };
  /** Loose floor cards (empty while the opening deal is still face down). */
  tableLoose: Card[];
  /** How many floor cards are still face down (pre-announce). */
  tableFaceDownCount: number;
  houses: SeepHouseView[];
  /** Captured pile SIZE per player (never the cards themselves). */
  captureCounts: Record<string, number>;
  /** Captured pile size per team (the physical face-down stacks). */
  teamPileCounts: { 0: number; 1: number };
  /** Cards of the most recent pick-up while still inspectable. */
  inspectableCardIds: string[];
  handCounts: Record<string, number>;
  /** Completed sweeps per team this deal. */
  sweeps: { 0: number; 1: number };
  /** Sweep bonus points banked per team this deal. */
  sweepPoints: { 0: number; 1: number };
  /** Live deal points per team (card points + sweep bonuses). */
  teamPoints: { 0: number; 1: number };
  /** The announced number (9–13); null until the bidder announces. */
  bid: number | null;
  /** Seat/player running this deal. */
  dealerId: string;
  bidderId: string;
  /** The bidder (announces and leads the first play). */
  openerId: string;
  dealNo: number;
  /** Total plays made so far in the deal. */
  playsMade: number;
  /** True while the rest of the deck is still to be dealt. */
  dealRestPending: boolean;
  batchesRemaining: number;
  /** Team of the last pick-up (leftover floor cards go to it). */
  lastCaptureTeam: SeepTeam | null;
  /** Running signed baazi lead (positive = team 0 ahead). */
  baaziLead: number;
  /** Completed baazis per team. */
  baazisWon: { 0: number; 1: number };
  dealHistory: SeepDealResultView[];
  /** Set on DEAL_COMPLETE / MATCH_COMPLETE. */
  roundResult: SeepDealResultView | null;
}

export function buildPlayerView(
  state: SeepState,
  viewerId: string,
  rules: SeepRules,
  opts?: { revealAll?: boolean },
): SeepPlayerView {
  const revealAll = opts?.revealAll ?? false;
  const viewer = state.players.find((p) => p.id === viewerId);
  const myTeam: SeepTeam | null = viewer ? teamOfSeat(viewer.seat) : null;
  const faceUpFloor = state.bid !== null;
  const dealOver = state.phase === 'DEAL_COMPLETE' || state.phase === 'MATCH_COMPLETE';

  const knownCards: Record<string, Card> = {};
  const addAll = (cards: Card[]): void => {
    for (const c of cards) knownCards[c.id] = c;
  };

  // Own hand is always visible.
  addAll(state.hands[viewerId] ?? []);
  // Floor + house contents: public once the bid has been made.
  if (faceUpFloor || dealOver) {
    addAll(state.tableLoose);
    for (const h of state.houses) addAll(h.cards);
  }
  // The most recent pick-up stays inspectable until the next player plays.
  const inspectableCardIds: string[] = [];
  if (state.lastPickup && state.playsMade === state.lastPickup.playsMade) {
    inspectableCardIds.push(...state.lastPickup.cardIds);
  }
  if (faceUpFloor || dealOver) {
    for (const id of inspectableCardIds) {
      const card =
        state.tableLoose.find((c) => c.id === id) ??
        state.houses.flatMap((h) => h.cards).find((c) => c.id === id) ??
        Object.values(state.captures).flat().find((c) => c.id === id);
      if (card) knownCards[id] = card;
    }
  }
  if (revealAll) {
    for (const hand of Object.values(state.hands)) addAll(hand);
    addAll(state.tableLoose);
    for (const h of state.houses) addAll(h.cards);
    for (const pile of Object.values(state.captures)) addAll(pile);
    addAll(state.deck);
  }

  const houses: SeepHouseView[] = state.houses.map((h) => ({
    id: h.id,
    total: h.total,
    ownerByTeam: { ...h.ownerByTeam },
    owners: Object.values(h.ownerByTeam).filter((x): x is string => !!x),
    copies: houseCopies(h),
    pakka: houseIsPakka(h),
    cards: [...h.cards],
  }));

  const teamPileCounts: { 0: number; 1: number } = { 0: 0, 1: 0 };
  const captureCounts: Record<string, number> = {};
  for (const p of state.players) {
    const n = state.captures[p.id]?.length ?? 0;
    captureCounts[p.id] = n;
    teamPileCounts[teamOfSeat(p.seat)] += n;
  }

  const teamPoints: { 0: number; 1: number } = { 0: 0, 1: 0 };
  for (const p of state.players) {
    for (const c of state.captures[p.id] ?? []) {
      teamPoints[teamOfSeat(p.seat)] += cardPointsLocal(c, rules);
    }
  }
  teamPoints[0] += state.sweepPoints[0];
  teamPoints[1] += state.sweepPoints[1];

  const teams: { 0: string[]; 1: string[] } = { 0: [], 1: [] };
  for (const p of state.players) teams[teamOfSeat(p.seat)].push(p.id);

  const roundResult: SeepDealResultView | null =
    state.teamScores && state.dealHistory.length > 0
      ? (() => {
          const last = state.dealHistory[state.dealHistory.length - 1]!;
          return {
            dealNo: last.dealNo,
            teamScores: { ...last.teamScores },
            winnerTeam: last.teamScores[0] > last.teamScores[1] ? 0 : last.teamScores[1] > last.teamScores[0] ? 1 : null,
            baaziLead: state.baaziLead,
            baazisWon: { ...state.baazisWon },
            baazi: last.baazi ? { ...last.baazi } : null,
            leftoverTeam: last.leftoverTeam,
          };
        })()
      : null;

  const remainingPackets = state.dealRestPending ? Math.ceil(state.deck.length / 4) : 0;

  return {
    gameId: 'seep',
    revision: state.revision,
    phase: state.phase,
    players: state.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      cardCount: state.hands[p.id]?.length ?? 0,
      isCurrentTurn: i === state.currentTurn,
    })),
    knownCards,
    handCardIds: Object.fromEntries(
      state.players.map((p) => [p.id, (state.hands[p.id] ?? []).map((c) => c.id)]),
    ),
    deckCount: state.deck.length,
    discardTop: null,
    events: state.events,
    myTeam,
    teams,
    tableLoose: faceUpFloor || dealOver ? [...state.tableLoose] : [],
    tableFaceDownCount: faceUpFloor || dealOver ? 0 : state.tableLoose.length,
    houses,
    captureCounts,
    teamPileCounts,
    inspectableCardIds,
    handCounts: Object.fromEntries(state.players.map((p) => [p.id, state.hands[p.id]?.length ?? 0])),
    sweeps: { ...state.sweeps },
    sweepPoints: { ...state.sweepPoints },
    teamPoints,
    bid: state.bid,
    dealerId: state.players[state.dealerSeat]?.id ?? '',
    bidderId: state.players[state.bidderSeat]?.id ?? '',
    openerId: state.players[state.bidderSeat]?.id ?? '',
    dealNo: state.dealNo,
    playsMade: state.playsMade,
    dealRestPending: state.dealRestPending,
    batchesRemaining: remainingPackets,
    lastCaptureTeam: state.lastCaptureTeam,
    baaziLead: state.baaziLead,
    baazisWon: { ...state.baazisWon },
    dealHistory: state.dealHistory.map((d) => ({
      dealNo: d.dealNo,
      teamScores: { ...d.teamScores },
      winnerTeam: d.teamScores[0] > d.teamScores[1] ? 0 : d.teamScores[1] > d.teamScores[0] ? 1 : null,
      baaziLead: d.leadAfter,
      baazisWon: { ...d.baazisWonAfter },
      baazi: d.baazi ? { ...d.baazi } : null,
      leftoverTeam: d.leftoverTeam,
    })),
    roundResult,
  };
}

/** Local copy to avoid a rules→views import cycle. */
function cardPointsLocal(card: Card, rules: SeepRules): number {
  if (card.suit === 'spades') return card.rank;
  if (card.rank === 1) return 1;
  if (card.suit === 'diamonds' && card.rank === 10) return rules.tenDiamondsPoints;
  return 0;
}
