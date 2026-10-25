// Teacher data for Laya-on-Cabo.
//
// Games are played by heuristic bots (with a little exploration). At every
// real decision of every seat, each candidate move is scored by rollouts:
// re-deal the cards that seat cannot see, apply the move, play the round out
// with heuristic bots, and average the payoff. The same re-deals are used for
// every candidate (common random numbers) so the comparison is fair. Acting
// greedily on these values improves on the rollout policy, and the soft
// targets tell Laya how much better each move is, not just which one won.
//
// usage: node teacher.mjs <out.jsonl> <games> <workers> [rollouts] [seedBase]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  actorOf, applyFor, buildDecision, candidateMoves, createAgentRng, determinize,
  engineFrom, heuristicBots, newGame, payoff, playOut, stateText,
} from './cabo-common.mjs';

const TAU = 0.05;
const EXPLORE = 0.15;

function scoreMoves(state, me, moves, rollouts, rng) {
  const totals = new Array(moves.length).fill(0);
  const counts = new Array(moves.length).fill(0);
  for (let r = 0; r < rollouts; r++) {
    const world = determinize(state, me, rng);
    const rolloutSeed = Math.floor(rng.next() * 2 ** 31);
    for (let i = 0; i < moves.length; i++) {
      const e = engineFrom(world);
      if (!e.handleAction({ ...moves[i], playerId: me }).ok) continue;
      const bots = heuristicBots(e.getState().players);
      if (!playOut(e, bots, createAgentRng(rolloutSeed))) continue;
      totals[i] += payoff(e.getState(), me);
      counts[i] += 1;
    }
  }
  return totals.map((t, i) => (counts[i] ? t / counts[i] : 0));
}

function generateGame(seed, rollouts) {
  const rng = createAgentRng(seed * 7919 + 13);
  const players = [0, 1, 2].map((i) => ({ id: `p${i}`, name: ['You', 'Ada', 'Byron'][i], seat: i }));
  // Each seat sees itself as "You" in its own state text.
  const engine = newGame(players, seed);
  const bots = heuristicBots(players);
  const rows = [];
  for (let step = 0; step < 600; step++) {
    const s = engine.getState();
    const who = actorOf(s);
    if (!who) break;
    const view = engine.getPlayerState(who);
    const moves = s.phase === 'INITIAL_PEEK' ? [] : candidateMoves(view, who, rng);
    const botAction = bots[who].decide({ gameId: 'cabo', selfId: who, view, step }, { rng }).action;
    if (moves.length > 1) {
      const q = scoreMoves(s, who, moves, rollouts, rng);
      const named = relabel(view, who);
      const { questions, gold } = buildDecision(moves, named, who);
      const heurIdx = moves.findIndex((m) => sameAction(m, botAction));
      rows.push({
        state: stateText(named, who),
        questions,
        gold: gold(q, TAU),
        meta: { seed, step, phase: s.phase, q: q.map((v) => +v.toFixed(4)), heuristic: heurIdx, n: moves.length },
      });
    }
    // Behaviour: the heuristic bot, with some random moves for state variety.
    const act = moves.length > 1 && rng.next() < EXPLORE ? rng.pick(moves) : botAction;
    if (!applyFor(engine, who, act)) break;
  }
  return rows;
}

/** Show the deciding seat as "You" and the others by table name. */
function relabel(view, me) {
  const others = view.players.filter((p) => p.id !== me);
  const names = new Map([[me, 'You'], ...others.map((p, i) => [p.id, ['Ada', 'Byron', 'Cora', 'Dov', 'Esme'][i]])]);
  return { ...view, players: view.players.map((p) => ({ ...p, name: names.get(p.id) })) };
}

function sameAction(a, b) {
  const strip = ({ playerId, ...rest }) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b ?? {}));
}

if (isMainThread) {
  const [out, gamesArg, workersArg, rolloutsArg, seedArg] = process.argv.slice(2);
  const games = Number(gamesArg ?? 10);
  const workers = Number(workersArg ?? 4);
  const rollouts = Number(rolloutsArg ?? 16);
  const seedBase = Number(seedArg ?? 1);
  const stream = createWriteStream(out, { flags: 'a' });
  let next = 0;
  let done = 0;
  let rowsN = 0;
  const t0 = Date.now();
  const start = () => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { rollouts } });
    const feed = () => {
      if (next >= games) { w.postMessage(null); return; }
      w.postMessage(seedBase + next++);
    };
    w.on('message', (rows) => {
      for (const r of rows) stream.write(JSON.stringify(r) + '\n');
      rowsN += rows.length;
      done += 1;
      if (done % 10 === 0 || done === games) {
        const el = (Date.now() - t0) / 1000;
        console.log(`games ${done}/${games} rows ${rowsN} elapsed ${el.toFixed(0)}s (${(rowsN / el).toFixed(2)} rows/s)`);
      }
      feed();
    });
    w.on('error', (e) => console.error('worker error', e));
    feed();
  };
  for (let i = 0; i < workers; i++) start();
} else {
  parentPort.on('message', (seed) => {
    if (seed == null) { process.exit(0); }
    parentPort.postMessage(generateGame(seed, workerData.rollouts));
  });
}
