// Head-to-head: seat p0 is the agent under test, the other seats are the
// built-in heuristic bot. Reports p0's win rate (ties split) with a 95% CI.
//
// usage: node eval.mjs <agent> <games> <workers> [players] [seedBase] [opponents]
//   opponents: heuristic (default) | laya:<url>
//   agent: heuristic | teacher:<rollouts> | laya:<http://host:port> | random
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { layaRelabelView } from '@game-night/agent-bots';
import {
  actorOf, applyFor, buildDecision, candidateMoves, createAgentRng, determinize, engineFrom,
  heuristicBots, newGame, payoff, playOut, stateText,
} from './cabo-common.mjs';

function teacherMove(state, me, moves, rollouts, rng) {
  const totals = new Array(moves.length).fill(0);
  for (let r = 0; r < rollouts; r++) {
    const world = determinize(state, me, rng);
    const seed = Math.floor(rng.next() * 2 ** 31);
    for (let i = 0; i < moves.length; i++) {
      const e = engineFrom(world);
      if (!e.handleAction({ ...moves[i], playerId: me }).ok) { totals[i] -= 1e9; continue; }
      playOut(e, heuristicBots(e.getState().players), createAgentRng(seed));
      totals[i] += payoff(e.getState(), me);
    }
  }
  let best = 0;
  for (let i = 1; i < moves.length; i++) if (totals[i] > totals[best]) best = i;
  return moves[best];
}

async function layaMove(url, view, me, moves, stats) {
  const named = layaRelabelView(view, me);
  const { questions, decode } = buildDecision(moves, named, me);
  const t0 = Date.now();
  const res = await fetch(`${url}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: stateText(named, me), questions }),
  });
  stats.ms += Date.now() - t0;
  stats.n += 1;
  const body = await res.json();
  const action = decode(body.answers);
  if (!action) stats.bad += 1;
  return action ?? moves[0];
}

async function playGame(seed, agentSpec, nPlayers, oppSpec = 'heuristic') {
  const players = Array.from({ length: nPlayers }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i }));
  const engine = newGame(players, seed);
  const rng = createAgentRng(seed * 31 + 7);
  const bots = heuristicBots(players);
  const stats = { ms: 0, n: 0, bad: 0 };
  const [kind, arg] = agentSpec.split(/:(.*)/s);
  for (let step = 0; step < 800; step++) {
    const s = engine.getState();
    const who = actorOf(s);
    if (!who) break;
    const view = engine.getPlayerState(who);
    let action;
    if (who === 'p0' && kind !== 'heuristic' && s.phase !== 'INITIAL_PEEK') {
      const moves = candidateMoves(view, who, rng);
      if (moves.length === 1) action = moves[0];
      else if (kind === 'teacher') action = teacherMove(s, who, moves, Number(arg || 64), rng);
      else if (kind === 'laya') action = await layaMove(arg, view, who, moves, stats);
      else action = rng.pick(moves);
    } else if (oppSpec.startsWith('laya:') && s.phase !== 'INITIAL_PEEK') {
      const moves = candidateMoves(view, who, rng);
      action = moves.length === 0
        ? bots[who].decide({ gameId: 'cabo', selfId: who, view, step }, { rng }).action
        : moves.length === 1 ? moves[0] : await layaMove(oppSpec.slice(5), view, who, moves, { ms: 0, n: 0, bad: 0 });
    } else {
      action = bots[who].decide({ gameId: 'cabo', selfId: who, view, step }, { rng }).action;
    }
    if (!applyFor(engine, who, action)) break;
  }
  const fs = engine.getState();
  const winners = fs.tiedWinnerIds?.length ? fs.tiedWinnerIds : fs.roundWinnerId ? [fs.roundWinnerId] : [];
  return { win: winners.includes('p0') ? 1 / winners.length : 0, score: fs.scores?.p0 ?? null, payoff: payoff(fs, 'p0'), stats };
}

if (isMainThread) {
  const [agent, gamesArg, workersArg, playersArg, seedArg, oppArg] = process.argv.slice(2);
  const opponents = oppArg ?? 'heuristic';
  const games = Number(gamesArg ?? 200);
  const workers = Number(workersArg ?? 4);
  const nPlayers = Number(playersArg ?? 3);
  const seedBase = Number(seedArg ?? 900000);
  let next = 0, done = 0, wins = 0, scoreSum = 0, ms = 0, n = 0, bad = 0;
  const t0 = Date.now();
  await new Promise((resolve) => {
    let alive = workers;
    for (let k = 0; k < workers; k++) {
      const w = new Worker(fileURLToPath(import.meta.url), { workerData: { agent, nPlayers, opponents } });
      const feed = () => w.postMessage(next < games ? seedBase + next++ : null);
      w.on('message', (r) => {
        done += 1; wins += r.win; scoreSum += r.score ?? 0; ms += r.stats.ms; n += r.stats.n; bad += r.stats.bad;
        feed();
      });
      w.on('exit', () => { if (--alive === 0) resolve(); });
      feed();
    }
  });
  const p = wins / done;
  const z = 1.96, den = 1 + z * z / done;
  const centre = (p + z * z / (2 * done)) / den;
  const half = (z * Math.sqrt(p * (1 - p) / done + z * z / (4 * done * done))) / den;
  console.log(JSON.stringify({
    agent, opponents, games: done, players: nPlayers, winRate: +p.toFixed(4),
    ci95: [+(centre - half).toFixed(4), +(centre + half).toFixed(4)],
    meanScore: +(scoreSum / done).toFixed(2), seconds: Math.round((Date.now() - t0) / 1000),
    ...(n ? { modelCalls: n, msPerCall: +(ms / n).toFixed(1), undecodable: bad } : {}),
  }));
} else {
  parentPort.on('message', async (seed) => {
    if (seed == null) process.exit(0);
    parentPort.postMessage(await playGame(seed, workerData.agent, workerData.nPlayers, workerData.opponents));
  });
}
