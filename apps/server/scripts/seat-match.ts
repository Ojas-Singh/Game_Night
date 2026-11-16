/**
 * The trained player against the heuristic bots at real tables.
 *   tsx scripts/seat-match.ts <model dir> <game> <rounds> [samples]
 * The model takes every second seat (in Seep: one team), starting from seat 0
 * in even rounds and seat 1 in odd ones. Prints one JSON line.
 */
import { Room } from '../src/room.js';
import { AgentLoops } from '../src/agents/loop.js';
import { ModelPlayer } from '../src/agents/model.js';

const [dir, gameId, roundsArg, samplesArg] = process.argv.slice(2);
const rounds = Number(roundsArg ?? 100);
const seats = gameId === 'seep' ? 4 : 2;
const model = await ModelPlayer.load(dir!, { samples: Number(samplesArg ?? 16) });

async function play(index: number): Promise<{ win: number; margin: number } | null> {
  const room = new Room();
  const host = room.addPlayer('Host').player;
  room.gameId = gameId as never;
  for (let i = 1; i < seats; i += 1) room.addAiPlayer(host.id);
  room.startGame(host.id);
  host.kind = 'ai';
  const state = (): any => room.engine!.getState();
  const order: string[] = state().players.map((p: { id: string }) => p.id);
  const mine = new Set(order.filter((_, seat) => seat % 2 === index % 2));
  const loops: AgentLoops = new AgentLoops(
    {} as never,
    { afterChange: () => loops.notify(room) },
    { minThinkMs: 1, maxThinkMs: 2, model, modelSeat: (id) => mine.has(id) },
  );
  const over = (): boolean =>
    room.engine!.isGameFinished() ||
    ['ROUND_COMPLETE', 'ROUND_REVEAL', 'DEAL_COMPLETE', 'MATCH_COMPLETE'].includes(state().phase);
  const deadline = Date.now() + 600_000;
  try {
    while (!over() && Date.now() < deadline) {
      loops.notify(room);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    loops.dispose();
  }
  if (!over()) return null;
  const s = state();
  if (gameId === 'seep') {
    const team = index % 2;
    const t = s.teamScores ?? s.lastDeal?.teamScores;
    const margin = t[team] - t[1 - team];
    return { win: margin > 0 ? 1 : margin < 0 ? 0 : 0.5, margin };
  }
  const me = order[index % 2]!;
  const other = order[1 - (index % 2)]!;
  const win = s.roundWinnerId === me ? 1 : s.roundWinnerId === other ? 0 : 0.5;
  // Cabo counts hand totals (low is good), Pair One counts pairs (high is good).
  const margin = gameId === 'cabo' ? s.scores[other] - s.scores[me] : s.scores[me] - s.scores[other];
  return { win, margin };
}

const results: Array<{ win: number; margin: number }> = [];
let unfinished = 0;
let next = 0;
const started = Date.now();
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < rounds) {
      const index = next++;
      const r = await play(index);
      if (r) results.push(r);
      else unfinished += 1;
    }
  }),
);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const se = (xs: number[]): number => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1) / xs.length);
};
const wins = results.map((r) => r.win);
const margins = results.map((r) => r.margin);
console.log(JSON.stringify({
  game: gameId, samples: model.settings.samples, rounds: results.length, unfinished,
  winShare: +mean(wins).toFixed(3), winSe: +se(wins).toFixed(3),
  margin: +mean(margins).toFixed(2), marginSe: +se(margins).toFixed(2),
  seconds: Math.round((Date.now() - started) / 1000),
}));
process.exit(0);
