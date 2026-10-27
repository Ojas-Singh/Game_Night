// Self-play teacher for the next Laya round.
//
// Positions come from games where every seat is the current Laya model
// (sampling from its move probabilities for variety). At each decision every
// candidate move is scored by rollouts in which ALL seats keep playing as
// Laya (greedy), after re-dealing the cards the deciding seat cannot see:
// "which move leads to winning games among Laya players". Targets are
// softmax(Q / tau) as in teacher.mjs, so the same trainer applies.
//
// Model calls go to batch_server.py (POST /batch). Everything runs as async
// tasks in one process; a micro-batcher sends all pending decisions together.
//
// usage: node selfplay.mjs <server-url> <out.jsonl> <games> [rollouts] [seedBase] [concurrency]
import { createWriteStream } from 'node:fs';
import {
  actorOf, applyFor, buildDecision, candidateMoves, createAgentRng, determinize, engineFrom,
  heuristicBots, newGame, payoff, playOut, stateText,
} from './cabo-common.mjs';
import { enumerateLegalActions } from '@game-night/agent-core';

const [url, out, gamesArg, rolloutsArg, seedArg, concArg] = process.argv.slice(2);
const GAMES = Number(gamesArg ?? 100);
const ROLLOUTS = Number(rolloutsArg ?? 16);
const SEED = Number(seedArg ?? 500001);
const CONCURRENCY = Number(concArg ?? 24);
const TAU = 0.05;
const SAMPLE_TEMP = 1.0; // behaviour policy: sample Laya's distribution
const MAX_BATCH = 512;
// Rollouts: Laya plays this many decisions (all seats), then the heuristic
// bots finish the round. Keeps model calls per position affordable.
const LAYA_PLIES = Number(process.env.LAYA_PLIES ?? 8);
const NAMES = ['Ada', 'Byron', 'Cora', 'Dov', 'Esme'];

// ---- micro-batched model client ------------------------------------------
let pending = [];
let flushScheduled = false;
let inFlight = 0;
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
  inFlight += 1;
  try {
    const res = await fetch(`${url}/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: batch.map(({ state, questions }) => ({ state, questions })) }),
    });
    const body = await res.json();
    stats.calls += batch.length;
    stats.batches += 1;
    body.results.forEach((r, i) => (r?.error ? batch[i].reject(new Error(r.error)) : batch[i].resolve(r)));
  } catch (e) {
    batch.forEach((b) => b.reject(e));
  } finally {
    inFlight -= 1;
  }
}

// ---- Laya as a player -----------------------------------------------------
function named(view, me) {
  const others = view.players.filter((p) => p.id !== me);
  const names = new Map([[me, 'You'], ...others.map((p, i) => [p.id, NAMES[i]])]);
  return { ...view, players: view.players.map((p) => ({ ...p, name: names.get(p.id) })) };
}

/** Laya's move for `who`; greedy, or sampled from its probabilities. */
async function layaMove(engine, who, rng, sample) {
  const view = engine.getPlayerState(who);
  const moves = candidateMoves(view, who, rng);
  if (moves.length === 0) return null;
  if (moves.length === 1) return moves[0];
  const v = named(view, who);
  const { questions, decode } = buildDecision(moves, v, who);
  const r = await ask(stateText(v, who), questions);
  const labels = {};
  for (const [qid, label] of Object.entries(r.answers)) {
    if (!sample) { labels[qid] = label; continue; }
    const probs = Object.entries(r.probabilities[qid] ?? {});
    let x = rng.next();
    const w = probs.map(([, p]) => Math.pow(p, 1 / SAMPLE_TEMP));
    const z = w.reduce((a, b) => a + b, 0);
    labels[qid] = probs[probs.length - 1][0];
    for (let i = 0; i < probs.length; i++) { x -= w[i] / z; if (x <= 0) { labels[qid] = probs[i][0]; break; } }
  }
  return decode(labels) ?? moves[0];
}

async function step(engine, who, rng, sample, i) {
  const s = engine.getState();
  let action;
  if (s.phase === 'INITIAL_PEEK') {
    action = enumerateLegalActions(engine.getPlayerState(who), who)[0];
  } else {
    action = await layaMove(engine, who, rng, sample);
  }
  if (!action) return false;
  return applyFor(engine, who, action);
}

/** Laya (greedy) in every seat for LAYA_PLIES decisions, then heuristic bots. */
async function rollout(engine, rng) {
  for (let i = 0; i < LAYA_PLIES; i++) {
    const who = actorOf(engine.getState());
    if (!who) return true;
    if (!(await step(engine, who, rng, false, i))) return false;
  }
  return playOut(engine, heuristicBots(engine.getState().players), rng);
}

async function scoreMoves(state, me, moves, rng) {
  const tasks = [];
  const totals = new Array(moves.length).fill(0);
  const counts = new Array(moves.length).fill(0);
  for (let r = 0; r < ROLLOUTS; r++) {
    const world = determinize(state, me, rng);
    const seed = Math.floor(rng.next() * 2 ** 31);
    for (let i = 0; i < moves.length; i++) {
      tasks.push((async () => {
        const e = engineFrom(world);
        if (!e.handleAction({ ...moves[i], playerId: me }).ok) return;
        if (!(await rollout(e, createAgentRng(seed)))) return;
        totals[i] += payoff(e.getState(), me);
        counts[i] += 1;
      })());
    }
  }
  await Promise.all(tasks);
  return totals.map((t, i) => (counts[i] ? t / counts[i] : 0));
}

async function generateGame(seed, sink) {
  const rng = createAgentRng(seed * 7919 + 17);
  const nPlayers = 2 + (seed % 3); // 2, 3 and 4 players in turn
  const players = Array.from({ length: nPlayers }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i }));
  const engine = newGame(players, seed);
  let rows = 0;
  for (let i = 0; i < 400; i++) {
    const s = engine.getState();
    const who = actorOf(s);
    if (!who) break;
    if (s.phase !== 'INITIAL_PEEK') {
      const view = engine.getPlayerState(who);
      const moves = candidateMoves(view, who, rng);
      if (moves.length > 1) {
        const q = await scoreMoves(s, who, moves, rng);
        const v = named(view, who);
        const { questions, gold } = buildDecision(moves, v, who);
        sink({
          state: stateText(v, who), questions, gold: gold(q, TAU),
          meta: { seed, players: nPlayers, step: i, phase: s.phase, q: q.map((x) => +x.toFixed(4)), n: moves.length, source: 'selfplay', plies: LAYA_PLIES, rollouts: ROLLOUTS },
        });
        rows += 1;
      }
    }
    if (!(await step(engine, who, rng, true, i))) break;
  }
  return rows;
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
