// Shared pieces for the Laya-for-Cabo experiment: how a decision is shown to
// the model (state text + option texts), how hidden cards are re-dealt for
// search, and how a round is played out with the heuristic bots.
import { CaboEngine } from '@game-night/engine-cabo';
import { enumerateLegalActions, createAgentRng } from '@game-night/agent-core';
import { CaboHeuristicBot } from '@game-night/agent-bots';

// The model-facing text and option logic live in @game-night/agent-bots
// (laya-cabo.ts) so the live server and training use one implementation.
export {
  layaBuildDecision as buildDecision,
  layaCandidateMoves as candidateMoves,
  layaDescribeMove as describeAction,
  layaStateText as stateText,
  LAYA_INSTRUCTIONS as INSTRUCTIONS,
  LAYA_MAX_OPTIONS as MAX_OPTIONS,
} from '@game-night/agent-bots';

/** Who must act now in a Cabo state (arena convention: no interrupts). */
export function actorOf(s) {
  if (s.phase === 'ROUND_COMPLETE' || s.phase === 'ROUND_REVEAL') return null;
  if (s.phase === 'INITIAL_PEEK') return s.initialPeeksRemaining[0] ?? null;
  if (s.pendingPower) return s.pendingPower.playerId;
  if (s.pendingTransfers?.length) return s.pendingTransfers[0].fromPlayerId;
  return s.players[s.currentTurn]?.id ?? null;
}

/**
 * Re-deal every card `me` cannot see: hands (theirs and own unknown slots),
 * the deck, and a drawn card held by someone else. Card ids and positions
 * stay; only rank/suit move. Public cards (discard pile, revealed) stay.
 */
export function determinize(state, me, rng) {
  const s = structuredClone(state);
  const known = new Set(s.knowledge[me] ?? []);
  const slots = [];
  for (const pid of Object.keys(s.hands)) for (const c of s.hands[pid]) if (c && !known.has(c.id)) slots.push(c);
  for (const c of s.deck) slots.push(c);
  if (s.drawnCard && !known.has(s.drawnCard.id)) slots.push(s.drawnCard);
  const values = rng.shuffle(slots.map((c) => ({ rank: c.rank, suit: c.suit })));
  slots.forEach((c, i) => { c.rank = values[i].rank; c.suit = values[i].suit; });
  s.events = s.events.slice(-8);
  return s;
}

export function heuristicBots(players, persona = 'balanced') {
  return Object.fromEntries(players.map((p) => [p.id, new CaboHeuristicBot({ persona, idSuffix: `-${p.id}` })]));
}

/** Apply one action for `who`; on rejection fall back to the first legal move. */
export function applyFor(engine, who, action) {
  if (engine.handleAction({ ...action, playerId: who }).ok) return true;
  const legal = enumerateLegalActions(engine.getPlayerState(who), who);
  return legal.length > 0 && engine.handleAction({ ...legal[0], playerId: who }).ok;
}

/** Play the round to the end with the given agents (sync decide only). */
export function playOut(engine, agents, rng, cap = 600) {
  for (let i = 0; i < cap; i++) {
    const s = engine.getState();
    const who = actorOf(s);
    if (!who) return true;
    const view = engine.getPlayerState(who);
    let action;
    try {
      action = agents[who].decide({ gameId: 'cabo', selfId: who, view, step: i }, { rng }).action;
    } catch {
      // The heuristic bot occasionally finds no move in odd spots; play on.
      const legal = enumerateLegalActions(view, who);
      if (legal.length === 0) return false;
      action = rng.pick(legal);
    }
    if (!applyFor(engine, who, action)) return false;
  }
  return false;
}

/** Payoff for `me` once the round is over: mostly win (ties split), plus a
 *  little score margin to cut rollout variance. */
export function payoff(state, me) {
  const scores = state.scores ?? {};
  const winners = state.tiedWinnerIds?.length ? state.tiedWinnerIds : state.roundWinnerId ? [state.roundWinnerId] : [];
  const win = winners.includes(me) ? 1 / winners.length : 0;
  const mine = scores[me] ?? 0;
  const bestOther = Math.min(...Object.entries(scores).filter(([k]) => k !== me).map(([, v]) => v));
  const margin = Math.max(0, Math.min(1, 0.5 + (bestOther - mine) / 20));
  return 0.8 * win + 0.2 * margin;
}

export function newGame(players, seed) {
  const e = new CaboEngine();
  e.createGame(players, { seed });
  return e;
}

export function engineFrom(state) {
  const e = new CaboEngine();
  e.restoreState(structuredClone(state));
  return e;
}

export { createAgentRng };

