/**
 * Cabo bots against each other, straight on the engine (no table, no timers).
 *   tsx scripts/cabo-bots.ts <rounds> <players> <bot> <bot> ...
 * A bot is `new`, `new:<call confidence>` or `old`; the list is repeated to
 * fill the table and rotated by one seat every round. Prints one JSON line
 * per kind of bot: share of rounds won, how often it called and how often
 * the call won, and its mean score.
 */
import { CaboEngine, buildPlayerView } from '@game-night/engine-cabo';
import { createAgentRng, enumerateLegalActions, type GameAgent } from '@game-night/agent-core';
import { CaboHeuristicBot, worthFlushing } from '@game-night/agent-bots';

const [roundsArg, playersArg, ...kinds] = process.argv.slice(2);
const rounds = Number(roundsArg ?? 1000);
const n = Number(playersArg ?? 2);

async function make(kind: string): Promise<GameAgent> {
  if (kind === 'old') {
    // A scratch copy of an earlier bot, when one is there to compare against.
    const old = await import('../../../packages/agent-bots/src/cabo-old.js' as string);
    return new old.OldCaboBot();
  }
  const confidence = kind.split(':')[1];
  return new CaboHeuristicBot(confidence ? { callConfidence: Number(confidence) } : {});
}

const tally = new Map<string, { seats: number; wins: number; calls: number; callWins: number; score: number }>();
const bots = new Map<string, GameAgent>();
for (const kind of kinds) {
  bots.set(kind, await make(kind));
  tally.set(kind, { seats: 0, wins: 0, calls: 0, callWins: 0, score: 0 });
}
let unfinished = 0;
let steps = 0;
const started = Date.now();

for (let round = 0; round < rounds; round += 1) {
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i }));
  const kindOf = (id: string): string => kinds[(Number(id.slice(1)) + round) % kinds.length]!;
  const engine = new CaboEngine();
  engine.createGame(players, { seed: 1000 + round });
  const rng = createAgentRng(7919 * (round + 1));
  let guard = 0;
  while (!engine.isGameFinished() && guard < 3000) {
    guard += 1;
    const s = engine.getState() as any;
    // A known match may be flushed by anyone at any moment, as at a real table.
    let flushed = false;
    if (s.phase !== 'INITIAL_PEEK') {
      for (const p of players) {
        const view = buildPlayerView(s, p.id);
        const flushes = enumerateLegalActions(view, p.id).filter(
          (a) => (a.type === 'FLUSH_OWN' || a.type === 'FLUSH_OTHER') && worthFlushing(view, a) && engine.validateAction(a),
        );
        if (flushes.length === 0) continue;
        const d = await bots.get(kindOf(p.id))!.decide(
          { gameId: 'cabo', selfId: p.id, view, step: guard },
          { rng, allowedActions: flushes, interruptOnly: true },
        );
        if (engine.handleAction(d.action).ok) {
          flushed = true;
          break;
        }
      }
    }
    if (flushed) continue;
    const who: string =
      s.phase === 'TRANSFER_PENDING'
        ? s.pendingTransfers.find((t: any) => s.hands[t.fromPlayerId].some((c: unknown) => c != null)).fromPlayerId
        : s.phase === 'INITIAL_PEEK'
          ? s.initialPeeksRemaining[0]
          : s.players[s.currentTurn].id;
    const view = buildPlayerView(s, who);
    const d = await bots.get(kindOf(who))!.decide({ gameId: 'cabo', selfId: who, view, step: guard }, { rng });
    const done = engine.handleAction(d.action);
    if (!done.ok) throw new Error(`${kindOf(who)} played an illegal ${d.action.type} in ${s.phase}: ${done.error}`);
  }
  steps += guard;
  if (!engine.isGameFinished()) {
    unfinished += 1;
    continue;
  }
  const s = engine.getState() as any;
  const scores = engine.calculateScore();
  const winners: string[] = s.tiedWinnerIds;
  const called = s.events.filter((e: any) => e.type === 'CABO_CALLED' && !e.payload?.auto).at(-1)?.payload?.playerId;
  for (const p of players) {
    const t = tally.get(kindOf(p.id))!;
    t.seats += 1;
    t.score += scores[p.id]!;
    if (winners.includes(p.id)) t.wins += 1 / winners.length;
    if (called === p.id) {
      t.calls += 1;
      if (winners.includes(p.id)) t.callWins += 1;
    }
  }
}

for (const [kind, t] of tally) {
  console.log(
    JSON.stringify({
      bot: kind,
      players: n,
      winShare: +(t.wins / t.seats).toFixed(3),
      callsPerSeat: +(t.calls / t.seats).toFixed(3),
      callWon: t.calls ? +(t.callWins / t.calls).toFixed(3) : null,
      meanScore: +(t.score / t.seats).toFixed(2),
    }),
  );
}
console.log(JSON.stringify({ rounds, unfinished, decisionsPerRound: +(steps / rounds).toFixed(1), seconds: Math.round((Date.now() - started) / 1000) }));
