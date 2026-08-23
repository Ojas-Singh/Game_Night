/**
 * Generation evaluator — measures whether a trained adapter actually plays
 * better, the only metric that matters.
 *
 *   pnpm --filter @game-night/trainer eval --url http://gpu-box:8000/v1 \
 *     --model Qwen/Qwen3-8B [--adapter gen1] --game pairone \
 *     --episodes 20 --opponent heuristic
 *
 * Fixed seeds → candidate vs opponent(s) head-to-head. Reports win rate and
 * legality rate (share of decisions the model made WITHOUT falling back to
 * the built-in heuristic — hallucination pressure indicator).
 */

import type { GameId } from '@game-night/agent-core';
import { createAgentRng } from '@game-night/agent-core';
import {
  CaboHeuristicBot,
  MonteCarloBot,
  PairOneHeuristicBot,
  RandomBot,
} from '@game-night/agent-bots';
import { LlmAgent } from '@game-night/agent-llm';
import { runEpisode, EngineWorld, EloLadder, type EpisodeOutcome } from '@game-night/arena';

interface Args {
  game: GameId;
  episodes: number;
  seed: number;
  url: string;
  model: string;
  apiKey?: string;
  persona: string;
  opponent: 'random' | 'heuristic' | 'mc';
  sims: number;
}

function parseArgs(argv: string[]): Args {
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(`--${f}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = get('url');
  if (!url) {
    console.error('usage: eval --url <openai-compatible base> --model <id> [--adapter name] --game pairone --episodes 20');
    process.exit(1);
  }
  return {
    game: (get('game') ?? 'pairone') as GameId,
    episodes: Number(get('episodes') ?? 12),
    seed: Number(get('seed') ?? 1000),
    url,
    model: get('model') ?? 'qwen3-8b',
    apiKey: get('api-key'),
    persona: get('persona') ?? 'balanced',
    opponent: (get('opponent') ?? 'heuristic') as Args['opponent'],
    sims: Number(get('sims') ?? 64),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let world: EngineWorld | null = null;

  const makeOpponents = (): import('@game-night/agent-core').GameAgent[] => {
    const mk = (suffix: string) => {
      switch (args.opponent) {
        case 'random':
          return new RandomBot();
        case 'mc': {
          const w = () => {
            if (!world) throw new Error('world unbound');
            return world;
          };
          return new MonteCarloBot(w, { totalSims: args.sims, idSuffix: suffix });
        }
        default:
          return args.game === 'cabo' ? new CaboHeuristicBot({ idSuffix: suffix }) : new PairOneHeuristicBot(suffix);
      }
    };
    return [mk('-1'), mk('-2')];
  };

  const wins: number[] = [];
  const ladder = new EloLadder();

  // Counts model decisions vs silent heuristic fallbacks (legality signal).
  let decisions = 0;
  let fallbacks = 0;
  const countingCandidate = (): import('@game-night/agent-core').GameAgent => ({
    id: 'candidate',
    label: 'Candidate',
    async decide(obs, ctx) {
      decisions++;
      const d = await inner.decide(obs, ctx);
      if (typeof d.thought === 'string' && d.thought.startsWith('[fallback]')) fallbacks++;
      return d;
    },
  });
  let inner!: LlmAgent;

  for (let ep = 0; ep < args.episodes; ep++) {
    inner = new LlmAgent({
      baseUrl: args.url,
      apiKey: args.apiKey,
      model: args.model,
      persona: args.persona,
      idSuffix: `:${ep}`,
    });
    const agents = [countingCandidate(), ...makeOpponents()];
    world = null;
    const outcome: EpisodeOutcome = await runEpisode({
      gameId: args.game,
      seed: args.seed + ep,
      agents,
      recordSteps: false,
      bindWorld: (w) => {
        world = w;
      },
    });
    const ids = agents.map((a) => a.id);
    const candWon = outcome.winnerIds.includes('p0') ? 1 : 0;
    ladder.recordGame(ids, (id) => (id === ids[0] ? candWon : 1 - candWon));
    wins.push(candWon);
    console.log(
      `ep${String(ep).padStart(3)} seed=${args.seed + ep} ${candWon ? 'WIN ' : 'loss'} scores=${JSON.stringify(outcome.scores)} steps=${outcome.steps}`,
    );
  }

  const winRate = wins.reduce((a, b) => a + b, 0) / Math.max(1, wins.length);
  console.log('\n=== Candidate evaluation ===');
  console.log(`model=${args.model} persona=${args.persona} game=${args.game}`);
  console.log(`win rate vs ${args.opponent}: ${(winRate * 100).toFixed(1)}% over ${args.episodes} episodes`);
  console.log(`legality: ${decisions - fallbacks}/${decisions} decisions made by the model (${fallbacks} heuristic fallbacks)`);
  console.log(`candidate elo=${ladder.standings()[0]?.rating ?? '-'} opponents=${ladder.standings().slice(1).map((s) => s.rating).join(',') || '-'}`);
}

void main();
