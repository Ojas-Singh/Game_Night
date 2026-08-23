/**
 * SFT dataset builder — turns recorded arena episodes into chat-format
 * supervised-finetuning samples.
 *
 * Input : JSONL episodes written by the arena with --record --raw
 *         (raw per-step views are REQUIRED so prompts can be rebuilt
 *         byte-identically to what LlmAgent sends at inference).
 * Output: train.jsonl / val.jsonl in OpenAI-chat format:
 *           system = rules + persona
 *           user   = serialized situation + candidate actions
 *           assistant = {"thought": "...", "action": {...}}
 *
 * Selection policy (defaults):
 *   - only winning seats of finished episodes (winners teach; losers noise)
 *   - skip random-bot steps unless --include-random
 *   - heuristic/bot steps included only with --include-bots
 *   - dedupe identical observations (keep first)
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { enumerateLegalActions, RULES_TEXT, type GameId } from '@game-night/agent-core';
import type { AnyGameView, AnyGameAction } from '@game-night/agent-core';
import { buildLlmPrompt, personaOr, PERSONAS } from '@game-night/agent-llm';

export interface RawEpisode {
  gameId: GameId;
  seed: number;
  players: Array<{ id: string; name: string; agentId: string }>;
  startedAt?: string;
  result: { scores: Record<string, number>; winnerIds: string[]; normalized?: Record<string, number> } | null;
  steps: Array<{
    step: number;
    selfId: string;
    agentId: string;
    action: AnyGameAction;
    thought?: string;
    rawView?: unknown;
  }>;
}

export interface DatasetSample {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  meta: {
    gameId: GameId;
    seed: number;
    episodeAgent: string;
    selfId: string;
    step: number;
  };
}

export interface BuildOptions {
  includeRandom?: boolean;
  includeBots?: boolean;
  /** Keep losing seats' moves too (off by default). */
  includeLosers?: boolean;
  maxCandidates?: number;
}

const isRandomAgent = (agentId: string): boolean => agentId.startsWith('random');
const isBotAgent = (agentId: string): boolean =>
  !agentId.startsWith('llm:') && !isRandomAgent(agentId);

/** Persona id from an episode agent id ('llm:baiter:x' → baiter). */
function personaOf(agentId: string): string {
  if (!agentId.startsWith('llm:')) return 'balanced';
  const part = agentId.slice(4).split(':')[0] ?? 'balanced';
  return PERSONAS[part] ? part : 'balanced';
}

export function buildSamples(episodes: RawEpisode[], opts: BuildOptions = {}): {
  samples: DatasetSample[];
  stats: { episodes: number; usableEpisodes: number; candidates: number; deduped: number };
} {
  const seen = new Set<string>();
  const samples: DatasetSample[] = [];
  let usable = 0;
  let candidatesSeen = 0;

  for (const ep of episodes) {
    if (!ep.result || !Array.isArray(ep.steps)) continue;
    const winners = new Set(ep.result.winnerIds);
    if (winners.size === 0) continue;
    usable++;

    for (const step of ep.steps) {
      const isWinnerSeat = winners.has(step.selfId);
      if (!opts.includeLosers && !isWinnerSeat) continue;
      if (isRandomAgent(step.agentId) && !opts.includeRandom) continue;
      if (isBotAgent(step.agentId) && !opts.includeBots && !step.agentId.startsWith('llm:')) continue;
      if (!step.rawView) continue; // cannot rebuild the exact prompt

      const view = step.rawView as AnyGameView;
      const all: AnyGameAction[] = enumerateLegalActions(view, step.selfId);
      candidatesSeen += all.length;
      // The recorded action must be one of today's legal actions — otherwise
      // engine/rules changed since recording and the sample would poison us.
      const chosen = all.find((a) => JSON.stringify(a) === JSON.stringify(step.action));
      if (!chosen) continue;

      // The model must be TRAINED on exactly what it will SEE: if the action
      // falls outside the candidate window the prompt will show, skip it.
      const cap = opts.maxCandidates ?? 200;
      const shown = all.slice(0, cap);
      if (!shown.some((a) => JSON.stringify(a) === JSON.stringify(chosen))) continue;

      const hash = createHash('sha1')
        .update(JSON.stringify([ep.gameId, step.selfId, view.revision, view.phase]))
        .digest('hex');
      if (seen.has(hash)) continue;
      seen.add(hash);

      const personaId = personaOf(step.agentId);
      const messages = buildLlmPrompt(
        { gameId: ep.gameId, selfId: step.selfId, view, step: step.step },
        personaOr(personaId),
        all,
        { maxCandidates: opts.maxCandidates },
      );
      const target = JSON.stringify({ thought: step.thought ?? '', action: chosen });
      samples.push({
        messages: [
          ...messages.slice(0, 2),
          { role: 'assistant', content: target },
        ],
        meta: {
          gameId: ep.gameId,
          seed: ep.seed,
          episodeAgent: step.agentId,
          selfId: step.selfId,
          step: step.step,
        },
      });
    }
  }
  return { samples, stats: { episodes: episodes.length, usableEpisodes: usable, candidates: candidatesSeen, deduped: samples.length } };
}

/** Shuffle deterministically then split into train/val. */
export function split<T>(items: T[], valFraction: number, seed: number): { train: T[]; val: T[] } {
  const arr = [...items];
  let a = seed >>> 0;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  const nVal = Math.floor(arr.length * valFraction);
  return { train: arr.slice(nVal), val: arr.slice(0, nVal) };
}

export function writeJsonl(path: string, rows: unknown[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

export function parseEpisodesFile(path: string): RawEpisode[] {
  const out: RawEpisode[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as RawEpisode);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(`--${f}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const input = get('in');
  if (!input) {
    console.error('usage: pnpm --filter @game-night/trainer dataset --in <episodes.jsonl> --out <dir> [--include-bots] [--include-random] [--include-losers]');
    process.exit(1);
  }
  const outDir = get('out') ?? 'sft-data';
  const episodes = parseEpisodesFile(input);
  const { samples, stats } = buildSamples(episodes, {
    includeRandom: argv.includes('--include-random'),
    includeBots: argv.includes('--include-bots'),
    includeLosers: argv.includes('--include-losers'),
  });
  const { train, val } = split(samples, Number(get('val') ?? 0.05), Number(get('seed') ?? 7));
  mkdirSync(outDir, { recursive: true });
  writeJsonl(join(outDir, 'train.jsonl'), train);
  writeJsonl(join(outDir, 'val.jsonl'), val);
  console.log(`episodes=${stats.episodes} usable=${stats.usableEpisodes}`);
  console.log(`samples=${samples.length} (deduped) → train=${train.length} val=${val.length}`);
  console.log(`games covered: ${[...new Set(samples.map((s) => s.meta.gameId))].join(', ') || '-'}`);
  console.log(`personas covered: ${[...new Set(samples.map((s) => s.messages[0]!.content.match(/You are "([^"]+)"/)?.[1] ?? ''))].filter(Boolean).join(', ') || '-'}`);
  console.log(`wrote ${outDir}/train.jsonl and ${outDir}/val.jsonl`);
}

// Run as CLI whether invoked as .ts (tsx) or compiled .js; never under vitest.
if (process.argv[1] && /[\\/]dataset\.(ts|js)$/.test(process.argv[1])) main();
