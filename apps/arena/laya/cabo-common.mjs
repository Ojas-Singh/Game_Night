// Shared pieces for the Laya-for-Cabo experiment: how a decision is shown to
// the model (state text + option texts), how hidden cards are re-dealt for
// search, and how a round is played out with the heuristic bots.
import { CaboEngine } from '@game-night/engine-cabo';
import { enumerateLegalActions, createAgentRng } from '@game-night/agent-core';
import { CaboHeuristicBot } from '@game-night/agent-bots';

export const MAX_OPTIONS = 20;
export const INSTRUCTIONS = 'Cabo: pick the move most likely to win (lowest total wins, black K = -1).';

const RL = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const SUIT = { hearts: '♥', diamonds: '♦', spades: '♠', clubs: '♣' };
export const cardText = (c) => (c ? `${RL[c.rank] ?? c.rank}${SUIT[c.suit]}` : 'unknown');

const VALUE = (c) => (c.rank === 13 ? (c.suit === 'hearts' || c.suit === 'diamonds' ? 13 : -1) : c.rank);

/** Short move text (Laya shares ~256 tokens across all options). */
export function describeAction(a, view, me) {
  const who = (pid) => (pid === me ? 'my' : view.players.find((p) => p.id === pid)?.name ?? pid);
  const slot = (pid, cid) => {
    const i = (view.handCardIds[pid] ?? []).indexOf(cid);
    const c = view.knownCards[cid];
    return `${who(pid)} #${i + 1} (${c ? cardText(c) : '?'})`;
  };
  switch (a.type) {
    case 'DRAW': return 'Draw';
    case 'KEEP_DRAWN': {
      const cid = view.handCardIds[me][a.handIndex];
      const old = view.knownCards[cid];
      const delta = old && view.drawnCard ? ` Δ${VALUE(view.drawnCard) - VALUE(old) >= 0 ? '+' : ''}${VALUE(view.drawnCard) - VALUE(old)}` : '';
      return `Keep ${cardText(view.drawnCard)} → ${slot(me, cid)}${delta}`;
    }
    case 'DISCARD_DRAWN': return `Discard drawn ${cardText(view.drawnCard)}`;
    case 'FLUSH_OWN': return `Flush ${a.cardIds.map((c) => slot(me, c)).join(' + ')}`;
    case 'FLUSH_OTHER': return `Flush ${slot(a.targetPlayerId, a.cardId)}`;
    case 'TRANSFER_CARD': return `Give ${slot(me, a.cardId)}`;
    case 'CALL_CABO': return 'Call Cabo';
    case 'END_TURN': return 'End turn';
    case 'POWER_APPLY': {
      const p = a.payload;
      if (p.power === 'PEEK_OWN') return `Peek ${slot(me, p.cardId)}`;
      if (p.power === 'PEEK_OTHER') return `Peek ${slot(p.targetPlayerId, p.cardId)}`;
      return `Swap ${slot(me, p.ownCardId)} ↔ ${slot(p.targetPlayerId, p.targetCardId)}`;
    }
    default: return a.type;
  }
}

/** Compact table text with correct suits and pre-computed totals. */
export function stateText(view, me) {
  const lines = [];
  const top = view.discardTop;
  lines.push(`Phase ${view.phase}. Deck ${view.deckCount}. Discard top ${top ? cardText(top) : 'none'}.`);
  const order = [...view.players.filter((p) => p.id === me), ...view.players.filter((p) => p.id !== me)];
  for (const p of order) {
    const ids = view.handCardIds[p.id] ?? [];
    let sum = 0, unknown = 0;
    const cells = ids.map((id, i) => {
      if (id.startsWith('__slot__')) return `#${i + 1} -`;
      const c = view.knownCards[id];
      if (c) sum += VALUE(c); else unknown += 1;
      return `#${i + 1} ${c ? cardText(c) : '?'}`;
    });
    const name = p.id === me ? 'You' : p.name;
    lines.push(`${name}${p.isCurrentTurn ? ' (to play)' : ''}: ${cells.join(', ')} | known ${sum}, unknown ${unknown}`);
  }
  if (view.drawnCard) lines.push(`You drew ${cardText(view.drawnCard)} (value ${VALUE(view.drawnCard)}).`);
  if (view.pendingPower) lines.push(`Power to use: ${view.pendingPower.power}.`);
  if (view.pendingTransfer) lines.push('You owe one of your cards to the player you flushed.');
  if (view.cabo) {
    const caller = view.cabo.callerId === me ? 'You' : view.players.find((p) => p.id === view.cabo.callerId)?.name;
    lines.push(`Cabo called by ${caller}: final round.`);
  }
  return lines.join('\n');
}

export const isSwapDecision = (moves) =>
  moves.length > 0 && moves.every((m) => m.type === 'POWER_APPLY' && m.payload.power === 'BLIND_SWAP');

/** Split a swap decision into "give" (own card) and "take" (their card). */
export function swapAxes(moves) {
  const give = [...new Set(moves.map((m) => m.payload.ownCardId))];
  const take = [...new Map(moves.map((m) => [`${m.payload.targetPlayerId}|${m.payload.targetCardId}`, m.payload])).values()];
  return { give, take };
}

const isBlindFlush = (a, view) =>
  (a.type === 'FLUSH_OWN' && a.cardIds.some((c) => !view.knownCards[c])) ||
  (a.type === 'FLUSH_OTHER' && !view.knownCards[a.cardId]);

/**
 * Legal moves, capped at MAX_OPTIONS for Laya. Everything except blind
 * flushes (guessing an unknown card) is kept; blind flushes fill the rest in
 * a seeded random order. The same rule is used for training and play.
 */
export function candidateMoves(view, me, rng) {
  const all = enumerateLegalActions(view, me);
  // Blind swaps are asked as two questions (give / take), so no cap.
  if (all.length <= MAX_OPTIONS || isSwapDecision(all)) return all;
  const keep = all.filter((a) => !isBlindFlush(a, view));
  const blind = rng.shuffle(all.filter((a) => isBlindFlush(a, view)));
  return [...keep, ...blind].slice(0, Math.max(MAX_OPTIONS, keep.length));
}

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

function slotText(view, me, pid, cid) {
  const name = pid === me ? 'my' : view.players.find((p) => p.id === pid)?.name ?? pid;
  const i = (view.handCardIds[pid] ?? []).indexOf(cid);
  const c = view.knownCards[cid];
  return `${name} #${i + 1} (${c ? cardText(c) : '?'})`;
}

export function softmax(q, tau) {
  const m = Math.max(...q);
  const ex = q.map((v) => Math.exp((v - m) / tau));
  const z = ex.reduce((a, b) => a + b, 0);
  return ex.map((v) => v / z);
}

/**
 * One decision as Laya questions. Returns the questions, a function turning
 * per-move values into soft targets (training), and a decoder from Laya's
 * chosen labels back to an engine action (play).
 */
export function buildDecision(moves, view, me) {
  const isSwap = (m) => m.type === 'POWER_APPLY' && m.payload.power === 'BLIND_SWAP';
  const swaps = moves.filter(isSwap);
  if (swaps.length > 0 && moves.length > MAX_OPTIONS) {
    const others = moves.filter((m) => !isSwap(m));
    const { give, take } = swapAxes(swaps);
    const keyOf = (m) => `${m.payload.ownCardId}|${m.payload.targetPlayerId}|${m.payload.targetCardId}`;
    const index = new Map(moves.map((m, i) => [isSwap(m) ? keyOf(m) : `x${i}`, i]));
    const otherIdx = moves.map((m, i) => i).filter((i) => !isSwap(moves[i]));
    const questions = {};
    if (others.length > 0) {
      questions.move = {
        type: 'choice',
        instructions: INSTRUCTIONS,
        criteria: Object.fromEntries([
          ...others.map((m, k) => [`o${k}`, describeAction(m, view, me)]),
          ['swap', 'Use the J/Q swap'],
        ]),
      };
    }
    questions.give = {
      type: 'choice',
      instructions: 'Cabo J/Q swap: which of YOUR cards to give away?',
      criteria: Object.fromEntries(give.map((cid, i) => [`g${i}`, `Give ${slotText(view, me, me, cid)}`])),
    };
    questions.take = {
      type: 'choice',
      instructions: 'Cabo J/Q swap: which card to take in return?',
      criteria: Object.fromEntries(take.map((t, i) => [`t${i}`, `Take ${slotText(view, me, t.targetPlayerId, t.targetCardId)}`])),
    };
    const swapIndex = (gi, ti) => index.get(`${give[gi]}|${take[ti]?.targetPlayerId}|${take[ti]?.targetCardId}`);
    const gold = (q, tau) => {
      const qv = (gi, ti) => q[swapIndex(gi, ti)] ?? -Infinity;
      const g = softmax(give.map((_, gi) => Math.max(...take.map((__, ti) => qv(gi, ti)))), tau);
      const t = softmax(take.map((_, ti) => Math.max(...give.map((__, gi) => qv(gi, ti)))), tau);
      const out = {
        give: { probabilities: Object.fromEntries(g.map((v, i) => [`g${i}`, +v.toFixed(5)])) },
        take: { probabilities: Object.fromEntries(t.map((v, i) => [`t${i}`, +v.toFixed(5)])) },
      };
      if (others.length > 0) {
        const best = Math.max(...swaps.map((m) => q[index.get(keyOf(m))]));
        const p = softmax([...otherIdx.map((i) => q[i]), best], tau);
        out.move = { probabilities: Object.fromEntries(p.map((v, k) => [k < others.length ? `o${k}` : 'swap', +v.toFixed(5)])) };
      }
      return out;
    };
    const decode = (labels) => {
      if (others.length > 0 && labels.move !== 'swap') {
        const k = Number(String(labels.move).slice(1));
        return otherIdx[k] == null ? null : moves[otherIdx[k]];
      }
      const i = swapIndex(Number(String(labels.give).slice(1)), Number(String(labels.take).slice(1)));
      return i == null ? null : moves[i];
    };
    return { questions, gold, decode };
  }
  const questions = {
    move: {
      type: 'choice',
      instructions: INSTRUCTIONS,
      criteria: Object.fromEntries(moves.map((m, i) => [`o${i}`, describeAction(m, view, me)])),
    },
  };
  const gold = (q, tau) => ({
    move: { probabilities: Object.fromEntries(softmax(q, tau).map((v, i) => [`o${i}`, +v.toFixed(5)])) },
  });
  const decode = (labels) => moves[Number(String(labels.move).slice(1))] ?? null;
  return { questions, gold, decode };
}
