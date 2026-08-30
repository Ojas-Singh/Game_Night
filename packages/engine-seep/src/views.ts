/**
 * Per-player filtered views of the Seep state.
 *
 * Hidden information security: a viewer receives card VALUES for their own
 * hand plus every face-up zone (table once announced, houses, captures).
 * Before the announce the table cards are face-DOWN — only their count is
 * public. Opponent hands travel as opaque ids only — unless Test Mode
 * reveals everything.
 */

import type { Card, GameEvent, PlayerView } from '@game-night/shared';
import { cardPoints, teamOfSeat, type SeepRules, type SeepTeam } from './rules.js';
import type { SeepHouse, SeepState } from './types.js';

export interface SeepHouseView {
  id: string;
  /** The house total (9–13) — a matching card captures it. */
  total: number;
  /** Owning player id + derived team. */
  ownerId: string;
  ownerTeam: SeepTeam;
  /** Complete sets joined into the house (1 = kachcha, 2+ = pakka). */
  sets: number;
  /** Pakka ghars cannot be broken — only captured. */
  pakka: boolean;
  /** The face-up cards joined into the house. */
  cards: Card[];
}

export interface SeepPlayerView extends PlayerView {
  /** Discriminator for the client (Cabo carries 'cabo', Pair One 'pairone'). */
  gameId: 'seep';
  /** Viewer's team (seat parity); null for non-seated viewers. */
  myTeam: SeepTeam | null;
  /** Player ids per team (team 0 = even seats, team 1 = odd seats). */
  teams: { 0: string[]; 1: string[] };
  /** The announced number (9–13); null until the opener announces. */
  bid: number | null;
  /** Id of the player who opens the deal. */
  openerId: string;
  /** Total plays made so far in the deal. */
  playsMade: number;
  /** Face-up loose cards on the table (public values; empty until announced). */
  tableLoose: Card[];
  /** How many face-down table cards are waiting for the announce (0 after). */
  tableFaceDownCount: number;
  /** Face-up houses (public totals + cards). */
  houses: SeepHouseView[];
  /** Cards captured per player, in pickup order (public information). */
  captures: Record<string, Card[]>;
  /** Hand sizes per player (hand VALUES stay filtered). */
  handCounts: Record<string, number>;
  sweeps: { 0: number; 1: number };
  /** Sweep bonus points banked per team. */
  sweepPoints: { 0: number; 1: number };
  /** Live team points (card points + sweep bonuses; majority lands at the end). */
  teamPoints: { 0: number; 1: number };
  /** Deal batches still to be handed out (0 once the rest is dealt). */
  batchesRemaining: number;
  lastCaptureTeam: SeepTeam | null;
  roundResult: {
    winnerTeam: SeepTeam | null;
    tiedTeams: SeepTeam[];
    teamScores: { 0: number; 1: number };
    majorityTeam: SeepTeam | null;
  } | null;
}

export function buildPlayerView(
  state: SeepState,
  viewerId: string,
  rules: SeepRules,
  opts?: { revealAll?: boolean },
): SeepPlayerView {
  const revealAll = opts?.revealAll === true;
  const announced = state.bid !== null;
  const known: Record<string, Card> = {};

  // Face-up zones are public to everyone (the table only once announced).
  const publicCards: Card[] = [
    ...(announced ? state.tableLoose : []),
    ...state.houses.flatMap((h) => h.cards),
    ...state.players.flatMap((p) => state.captures[p.id] ?? []),
  ];
  // Your own hand is yours to see.
  const myHand = state.hands[viewerId] ?? [];
  for (const card of [...publicCards, ...myHand]) known[card.id] = card;

  // Test Mode: reveal every card including opponent hands, the deck and the
  // still face-down table cards.
  if (revealAll) {
    for (const p of state.players) {
      for (const card of state.hands[p.id] ?? []) known[card.id] = card;
    }
    for (const card of state.deck) known[card.id] = card;
    if (!announced) for (const card of state.tableLoose) known[card.id] = card;
  }

  const handCardIds: Record<string, string[]> = {};
  const handCounts: Record<string, number> = {};
  for (const p of state.players) {
    const hand = state.hands[p.id] ?? [];
    handCardIds[p.id] = hand.map((c) => c.id);
    handCounts[p.id] = hand.length;
  }

  const teams: { 0: string[]; 1: string[] } = { 0: [], 1: [] };
  for (const p of state.players) teams[teamOfSeat(p.seat)].push(p.id);

  const tp: { 0: number; 1: number } = { 0: 0, 1: 0 };
  for (const p of state.players) {
    const team = teamOfSeat(p.seat);
    for (const c of state.captures[p.id] ?? []) tp[team] += cardPoints(c, rules);
  }
  tp[0] += state.sweepPoints[0];
  tp[1] += state.sweepPoints[1];

  const viewerPlayer = state.players.find((p) => p.id === viewerId);
  const houseTeam = (h: SeepHouse): SeepTeam => {
    const owner = state.players.find((p) => p.id === h.ownerId);
    return owner ? teamOfSeat(owner.seat) : 0;
  };

  return {
    revision: state.revision,
    phase: state.phase,
    gameId: 'seep',
    players: state.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      cardCount: handCounts[p.id] ?? 0,
      isCurrentTurn: i === state.currentTurn,
    })),
    knownCards: known,
    handCardIds,
    deckCount: state.deck.length,
    discardTop: null,
    events: state.events,
    myTeam: viewerPlayer ? teamOfSeat(viewerPlayer.seat) : null,
    teams,
    bid: state.bid,
    openerId: state.openerId,
    playsMade: state.playsMade,
    tableLoose: announced ? state.tableLoose : [],
    tableFaceDownCount: announced ? 0 : state.tableLoose.length,
    houses: state.houses.map(
      (h): SeepHouseView => ({
        id: h.id,
        total: h.total,
        ownerId: h.ownerId,
        ownerTeam: houseTeam(h),
        sets: h.sets,
        pakka: h.sets >= 2,
        cards: h.cards,
      }),
    ),
    captures: Object.fromEntries(state.players.map((p) => [p.id, state.captures[p.id] ?? []])),
    handCounts,
    sweeps: { ...state.sweeps },
    sweepPoints: { ...state.sweepPoints },
    teamPoints: tp,
    batchesRemaining: state.dealRestPending ? 3 : 0,
    lastCaptureTeam: state.lastCaptureTeam,
    roundResult:
      state.phase === 'ROUND_COMPLETE'
        ? {
            winnerTeam: state.roundWinnerTeam,
            tiedTeams: [...state.tiedTeams],
            teamScores: { ...(state.teamScores ?? { 0: 0, 1: 0 }) },
            majorityTeam: state.majorityTeam,
          }
        : null,
  };
}
