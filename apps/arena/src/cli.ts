/**
 * Arena CLI — batch self-play from the terminal.
 *
 *   pnpm --filter @game-night/arena arena --game pairone --episodes 200 \
 *     --seats heuristic,heuristic,random --seed 1 --out trajectories
 *
 * Outputs: ELO standings (stdout + ladder.json), win-rate table, and optional
 * JSONL trajectory files for the training pipeline.
 */

import { mkdirSync, readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameId } from '@game-night/agent-core';
import { createAgentRng, type GameAgent } from '@game-night/agent-core';
import { RandomBot, CaboHeuristicBot, PairOneHeuristicBot, MonteCarloBot } from '@game-night/agent-bots';
import { runEpisode } from './runner.js';
import { EloLadder, type LadderState } from './elo.js';
import type { EngineWorld } from './world.js';

interface CliArgs {
  game: GameId;
  episodes: number;
  seats: string[];
  seed: number;
  sims: number;
  out: string;
  record: boolean;
  raw: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const game = (get('game') ?? 'pairone') as GameId;
  if (game !== 'cabo' && game !== 'pairone') throw new Error(`unknown game ${game}`);
  return {
    game,
    episodes: Number(get('episodes') ?? 100),
    seats: (get('seats') ?? 'heuristic,heuristic,random').split(',').map((s) => s.trim()),
    seed: Number(get('seed') ?? Date.now() % 100000),
    sims: Number(get('sims') ?? 96),
    out: get('out') ?? 'trajectories',
    record: argv.includes('--record'),
    raw: argv.includes('--raw'),
  };
}

function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `arena: game=${args.game} episodes=${args.episodes} seats=${args.seats.join('+')} seed0=${args.seed} record=${args.record}`,
  );

  const ladderPath = join(args.out, 'ladder.json');
  mkdirSync(args.out, { recursive: true });
  const ladder = new EloLadder(
    existsSync(ladderPath) ? (JSON.parse(readFileSync(ladderPath, 'utf8')) as LadderState) : undefined,
  );

  // MC bots need the CURRENT episode's world; bindWorld hands it over.
  let boundWorld: EngineWorld | null = null;
  const buildAgent = (spec: string): GameAgent => {
    switch (spec) {
      case 'random':
        return new RandomBot();
      case 'heuristic':
      case 'h':
        return args.game === 'cabo' ? new CaboHeuristicBot() : new PairOneHeuristicBot();
      case 'mc':
      case 'mcts':
        return new MonteCarloBot(
          () => {
            if (!boundWorld) throw new Error('MC world not bound yet');
            return boundWorld;
          },
          { totalSims: args.sims },
        );
      default:
        throw new Error(`unknown seat spec '${spec}' (random|heuristic|mc)`);
    }
  };

  const wins: Record<string, number> = {};
  const gamesPlayed: Record<string, number> = {};
  const trajPath = args.record ? join(args.out, `${args.game}-episodes.jsonl`) : null;

  const run = async (): Promise<void> => {
    for (let ep = 0; ep < args.episodes; ep++) {
      const agents = args.seats.map((s) => buildAgent(s));
      boundWorld = null;
      const outcome = await runEpisode({
        gameId: args.game,
        seed: args.seed + ep,
        agents,
        recordSteps: args.record,
        recordRawViews: args.raw,
        bindWorld: (w) => {
          boundWorld = w;
        },
      });
      const ids = agents.map((a) => a.id);
      ladder.recordGame(ids, (id) => {
        const i = ids.indexOf(id);
        return outcome.winnerIds.includes(`p${i}`) ? 1 : 0;
      });
      for (const id of ids) gamesPlayed[id] = (gamesPlayed[id] ?? 0) + 1;
      for (const w of outcome.winnerIds) {
        const agentId = agents[Number(w.slice(1))]?.id;
        if (agentId) wins[agentId] = (wins[agentId] ?? 0) + 1;
      }
      if (trajPath && outcome.record) {
        appendFileSync(trajPath, JSON.stringify(outcome.record) + '\n');
      }
      if ((ep + 1) % Math.max(1, Math.floor(args.episodes / 10)) === 0) {
        console.log(`  ${ep + 1}/${args.episodes}`);
      }
    }

    writeFileSync(ladderPath, JSON.stringify(ladder.state, null, 2));
    console.log('\n=== Win rates ===');
    for (const [id, g] of Object.entries(gamesPlayed)) {
      const w = wins[id] ?? 0;
      console.log(`${id.padEnd(24)} ${String(w).padStart(4)}/${String(g).padEnd(4)} (${((w / g) * 100).toFixed(1)}%)`);
    }
    console.log('\n=== Elo standings ===');
    for (const row of ladder.standings()) {
      console.log(`${row.id.padEnd(24)} ${String(row.rating).padStart(5)}  (${row.games} games)`);
    }
    if (trajPath) console.log(`\ntrajectories → ${trajPath}`);
  };
  return run();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
