// Search teacher for Laya-on-Cabo (expert iteration).
//
// At every decision of every seat, each candidate move is scored by determinized search: the cards the deciding
// seat cannot see are re-dealt (consistent with everything public and everything that seat knows), the move is
// applied, and the round is played on with the current Laya model in EVERY seat, each reading its own view and the
// table memory (prompt version 2: unseen pool, who has seen which card, recent actions). Because the opponents in
// the simulation read the same table history, moves that mislead them (a kept card they will misjudge, a swap that
// hides a known card) score higher where they pay off: bluffing and table reading are learned from the search, not
// written in by hand.
//
// The rollout budget per position is spent by successive halving: every move gets a few rollouts, the worse half is
// dropped, the survivors get more, until the budget is used. Targets: move = softmax(Q / tau) over all moves
// (moves dropped early keep their last estimate); value ("winner") = the actual outcome of the game the position
// came from, so the next model also learns who is winning, and later rounds can stop rollouts early with it
// (VALUE_CUTOFF plies). Games follow the search's best move with probability FOLLOW (strong trajectories), else
// a sample of the model's distribution (variety).
//
// usage: node search.mjs <server-url> <out.jsonl> <games> [budget] [seedBase] [concurrency]
// env:   ROLLOUT_PLIES (0 = Laya to the end of the round; else Laya for that many decisions, then heuristic bots),
//        MODEL_PROMPT (1|2, the prompt the served model was trained on; 1 for v1-v3), RECORD_PROMPT (default 2),
//        FOLLOW (0.75), VALUE_CUTOFF (0 = play every rollout to the end of the round), TAU (0.05), PLAYERS (2,3,4)
import { createWriteStream } from 'node:fs';
import {
  actorOf, applyFor, buildDecision, candidateMoves, createAgentRng, determinize, engineFrom, newGame, payoff,
  decisionText, heuristicBots, playOut,
} from './cabo-common.mjs';
import { enumerateLegalActions } from '@game-night/agent-core';

const [url, out, gamesArg, budgetArg, seedArg, concArg] = process.argv.slice(2);
const GAMES = Number(gamesArg ?? 100);
const BUDGET = Number(budgetArg ?? 96);            // rollouts per position, spread over the moves
const SEED = Number(seedArg ?? 700001);
const CONCURRENCY = Number(concArg ?? 24);
const MODEL_PROMPT = Number(process.env.MODEL_PROMPT ?? 1);
const RECORD_PROMPT = Number(process.env.RECORD_PROMPT ?? 2);
const FOLLOW = Number(process.env.FOLLOW ?? 0.75);
const VALUE_CUTOFF = Number(process.env.VALUE_CUTOFF ?? 0);
// Laya plays the first ROLLOUT_PLIES decisions of a rollout (every seat), the heuristic bots finish the round on the
// CPU (0 = Laya to the end). Model calls are the cost of the search; until the model has a value head this keeps
// a position affordable.
const ROLLOUT_PLIES = Number(process.env.ROLLOUT_PLIES ?? 0);
const TAU = Number(process.env.TAU ?? 0.05);
const PLAYERS = (process.env.PLAYERS ?? '2,3,4').split(',').map(Number);
const MAX_BATCH = 512;
const NAMES = ['Ada', 'Byron', 'Cora', 'Dov', 'Esme'];
const VALUE_INSTRUCTIONS = 'Cabo: who will win this round?';

// ---- micro-batched model client (batch_server.py: POST /batch) -------------------------------------------------
let pending = [];
let flushScheduled = false;
const stats = { calls: 0, batches: 0, t0: Date.now() };
function ask(state, questions) {
  return new Promise((resolve, reject) => {
    pending.push({ state, questions, resolve, reject });
    if (pending.length >= MAX_BATCH) flush();
    else if (!flushScheduled) { flushScheduled = true; setImmediate(flush); }
  });
}
async function flush() {
  flushScheduled = false;
  if (pending.length === 0) return;
  const batch = pending.splice(0, MAX_BATCH);
  if (pending.length && !flushScheduled) { flushScheduled = true; setImmediate(flush); }
  try {
    const res = await fetch(`${url}/batch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: batch.map(({ state, questions }) => ({ state, questions })) }),
    });
    const body = await res.json();
    stats.calls += batch.length;
    stats.batches += 1;
    body.results.forEach((r, i) => (r?.error ? batch[i].reject(new Error(r.error)) : batch[i].resolve(r)));
  } catch (e) {
    batch.forEach((b) => b.reject(e));
  }
}

// ---- Laya as a player ---------------------------------------------------------------------------------------------
function named(view, me) {
  const others = view.players.filter((p) => p.id !== me);
  const names = new Map([[me, 'You'], ...others.map((p, i) => [p.id, NAMES[i]])]);
  return { ...view, players: view.players.map((p) => ({ ...p, name: names.get(p.id) })) };
}

/** The "who wins" question for the deciding seat: one option per seat, You first. */
export function valueQuestion(view, me) {
  const v = named(view, me);
  const order = [me, ...v.players.filter((p) => p.id !== me).map((p) => p.id)];
  return { order, question: { type: 'choice', instructions: VALUE_INSTRUCTIONS,
    criteria: Object.fromEntries(order.map((pid, i) => [`w${i}`, v.players.find((p) => p.id === pid).name])) } };
}

function pick(probs, rng) {
  const entries = Object.entries(probs ?? {});
  let x = rng.next();
  for (const [k, p] of entries) { x -= p; if (x <= 0) return k; }
  return entries[entries.length - 1]?.[0];
}

/** Laya's move for `who` (greedy, or sampled). */
async function layaMove(engine, who, rng, sample) {
  const view = engine.getPlayerState(who);
  const moves = candidateMoves(view, who, rng);
  if (moves.length <= 1) return moves[0] ?? null;
  const v = named(view, who);
  const { questions, decode } = buildDecision(moves, v, who);
  const r = await ask(decisionText(v, who, MODEL_PROMPT), questions);
  const labels = {};
  for (const qid of Object.keys(questions)) labels[qid] = sample ? pick(r.probabilities[qid], rng) : r.answers[qid];
  return decode(labels) ?? moves[0];
}

async function act(engine, who, rng, sample) {
  const s = engine.getState();
  const action = s.phase === 'INITIAL_PEEK'
    ? enumerateLegalActions(engine.getPlayerState(who), who)[0]
    : await layaMove(engine, who, rng, sample);
  return action ? applyFor(engine, who, action) : false;
}

/** The value of a state for `me`: play on with Laya in every seat (greedy) to the end, or, with VALUE_CUTOFF, ask
 *  the model who wins after that many plies. */
async function rolloutValue(engine, me, rng) {
  for (let i = 0; i < 800; i++) {
    const who = actorOf(engine.getState());
    if (!who) return payoff(engine.getState(), me);
    if (ROLLOUT_PLIES > 0 && i >= ROLLOUT_PLIES) {
      return playOut(engine, heuristicBots(engine.getState().players), rng) ? payoff(engine.getState(), me) : null;
    }
    if (VALUE_CUTOFF > 0 && i >= VALUE_CUTOFF) {
      const { order, question } = valueQuestion(engine.getPlayerState(me), me);
      const r = await ask(decisionText(named(engine.getPlayerState(me), me), me, MODEL_PROMPT), { winner: question });
      return r.probabilities.winner?.[`w${order.indexOf(me)}`] ?? 0;
    }
    if (!(await act(engine, who, rng, false))) return null;
  }
  return null;
}

/** Q of every move by determinized rollouts, the budget spent by successive halving. */
async function searchMoves(state, me, moves, rng) {
  const sum = new Array(moves.length).fill(0), n = new Array(moves.length).fill(0);
  let alive = moves.map((_, i) => i);
  const rounds = Math.max(1, Math.ceil(Math.log2(moves.length)));
  let left = BUDGET;
  for (let r = 0; r < rounds && alive.length > 0; r++) {
    const per = Math.max(2, Math.floor(left / (alive.length * (rounds - r))));
    const tasks = [];
    for (let k = 0; k < per; k++) {
      const world = determinize(state, me, rng);            // one re-deal shared by every move (common random numbers)
      const seed = Math.floor(rng.next() * 2 ** 31);
      for (const i of alive) {
        tasks.push((async () => {
          const e = engineFrom(world);
          if (!e.handleAction({ ...moves[i], playerId: me }).ok) return;
          const v = await rolloutValue(e, me, createAgentRng(seed));
          if (v == null) return;
          sum[i] += v; n[i] += 1;
        })());
      }
    }
    await Promise.all(tasks);
    left -= per * alive.length;
    if (alive.length > 1 && r < rounds - 1) {
      alive.sort((a, b) => (n[b] ? sum[b] / n[b] : -1) - (n[a] ? sum[a] / n[a] : -1));
      alive = alive.slice(0, Math.ceil(alive.length / 2));
    }
  }
  return { q: sum.map((s, i) => (n[i] ? s / n[i] : 0)), n };
}

async function generateGame(seed, sink) {
  const rng = createAgentRng(seed * 7919 + 17);
  const nPlayers = PLAYERS[seed % PLAYERS.length];
  const players = Array.from({ length: nPlayers }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i }));
  const engine = newGame(players, seed);
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const s = engine.getState();
    const who = actorOf(s);
    if (!who) break;
    if (s.phase !== 'INITIAL_PEEK') {
      const view = engine.getPlayerState(who);
      const moves = candidateMoves(view, who, rng);
      if (moves.length > 1) {
        const { q, n } = await searchMoves(s, who, moves, rng);
        const v = named(view, who);
        const { questions, gold, decode } = buildDecision(moves, v, who);
        const { order, question } = valueQuestion(view, who);
        rows.push({ who, order, row: {
          state: decisionText(v, who, RECORD_PROMPT), questions: { ...questions, winner: question }, gold: gold(q, TAU),
          meta: { seed, players: nPlayers, step: i, phase: s.phase, q: q.map((x) => +x.toFixed(4)), n, source: 'search',
                  budget: BUDGET, rollout_plies: ROLLOUT_PLIES, model_prompt: MODEL_PROMPT, record_prompt: RECORD_PROMPT },
        } });
        // follow the search (strong play), or sample the model (variety)
        let action;
        if (rng.next() < FOLLOW) action = moves[q.indexOf(Math.max(...q))];
        else {
          const r = await ask(decisionText(v, who, MODEL_PROMPT), questions);
          const labels = Object.fromEntries(Object.keys(questions).map((qid) => [qid, pick(r.probabilities[qid], rng)]));
          action = decode(labels) ?? moves[0];
        }
        if (!applyFor(engine, who, action)) break;
        continue;
      }
    }
    if (!(await act(engine, who, rng, true))) break;
  }
  // value targets: the outcome of this game, from each recorded seat's point of view
  const fs = engine.getState();
  const winners = fs.tiedWinnerIds?.length ? fs.tiedWinnerIds : fs.roundWinnerId ? [fs.roundWinnerId] : [];
  if (!winners.length) return 0;
  for (const { order, row } of rows) {
    row.gold.winner = { probabilities: Object.fromEntries(order.map((pid, k) => [`w${k}`, winners.includes(pid) ? 1 / winners.length : 0])) };
    sink(row);
  }
  return rows.length;
}

const stream = createWriteStream(out, { flags: 'a' });
let next = 0, done = 0, rowsTotal = 0;
const t0 = Date.now();
async function workerLoop() {
  while (next < GAMES) {
    const seed = SEED + next++;
    try {
      rowsTotal += await generateGame(seed, (r) => stream.write(JSON.stringify(r) + '\n'));
    } catch (e) {
      console.error('game', seed, 'failed:', e.message);
    }
    done += 1;
    if (done % 5 === 0 || done === GAMES) {
      const el = (Date.now() - t0) / 1000;
      console.log(`games ${done}/${GAMES} rows ${rowsTotal} ${(rowsTotal / el).toFixed(2)} rows/s, model ${(stats.calls / el).toFixed(0)} calls/s, mean batch ${(stats.calls / Math.max(stats.batches, 1)).toFixed(0)}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, workerLoop));
stream.end();
