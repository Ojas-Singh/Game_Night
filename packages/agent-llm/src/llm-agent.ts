/**
 * LlmAgent — a reasoning card player over any OpenAI-compatible endpoint.
 *
 * Prompt = rules + persona + serialized view + candidate actions. The model
 * answers with strict JSON: {"thought": "...", "action": {...}}. The action
 * is validated against the candidate list; on garbage we re-ask ONCE with
 * the error fed back, then fall back to a heuristic bot so a live table
 * never stalls on a hallucinating model.
 */

import {
  enumerateLegalActions,
  RULES_TEXT,
  serializeView,
  AgentError,
  type AnyGameAction,
  type AgentContext,
  type AgentDecision,
  type AgentObservation,
  type GameAgent,
} from '@game-night/agent-core';
import { CaboHeuristicBot, PairOneHeuristicBot } from '@game-night/agent-bots';
import { chat, type ChatMessage } from './chat.js';
import { personaOr, type Persona } from './personas.js';

export interface LlmAgentOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  persona?: string;
  idSuffix?: string;
  /** Extra sampling knobs. */
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Cap on serialized candidate list (large power menus get sampled). */
  maxCandidates?: number;
  /**
   * 'live-safe' (default): after a failed retry, silently fall back to the
   *   built-in heuristic so a multiplayer table never stalls.
   * 'research-strict': rethrow as AgentError — the runner records the model's
   *   failure verbatim; no heuristic strength may be credited to the model.
   */
  mode?: 'live-safe' | 'research-strict';
}

export interface PromptOptions {
  /** Full Pair One grids enumerate >100 flips; keep every candidate visible. */
  maxCandidates?: number;
}

/**
 * Build the EXACT chat messages an LlmAgent sends at decision time. Exported
 * so the training pipeline can render byte-identical prompts from recorded
 * episodes — distribution match between SFT data and live inference.
 */
export function buildLlmPrompt(
  obs: AgentObservation,
  persona: Persona,
  candidates: AnyGameAction[],
  opts: PromptOptions = {},
): ChatMessage[] {
  const maxCandidates = opts.maxCandidates ?? 200;
  return buildPromptInner(obs, persona, candidates, maxCandidates);
}

export interface CandidateRef {
  id: string;
  action: AnyGameAction;
}

/** Label candidates A0, A1, ... — small models select an ID far more reliably
 *  than they reproduce nested JSON. Both answer styles remain valid. */
export function labelCandidates(candidates: AnyGameAction[], max?: number): CandidateRef[] {
  const list = max != null && candidates.length > max ? candidates.slice(0, max) : candidates;
  return list.map((action, i) => ({ id: `A${i}`, action }));
}

function buildPromptInner(obs: AgentObservation, persona: Persona, candidates: AnyGameAction[], maxCandidates: number): ChatMessage[] {
  const refs = labelCandidates(candidates, maxCandidates);
  const system = [
    `You are "${persona.label}", a world-class card player in a game night app.`,
    persona.prompt,
    `GAME RULES:\n${RULES_TEXT[obs.gameId]}`,
    `Respond with ONE json object and nothing else: {"thought": "<=2 sentences of reasoning", "action_id": "<one candidate id, e.g. A7>"}. Copying the full action object as "action" instead of action_id is also acceptable.`,
  ].join('\n\n');
  const user = [
    `CURRENT SITUATION (you are "YOU", id ${obs.selfId}):`,
    serializeView(obs.view, obs.selfId),
    '',
    `LEGAL ACTIONS (pick exactly one id):`,
    ...refs.map((r) => `${r.id}: ${JSON.stringify(r.action)}`),
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function extractJson(text: string): { thought?: string; action?: unknown; action_id?: string } | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1]! : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as { thought?: string; action?: unknown };
  } catch {
    return null;
  }
}

function actionMatches(candidate: unknown, list: AnyGameAction[]): AnyGameAction | null {
  if (candidate == null || typeof candidate !== 'object') return null;
  const c = candidate as Record<string, unknown>;
  return (
    list.find((a) => {
      const ac = a as unknown as Record<string, unknown>;
      if (ac.type !== c.type || ac.playerId !== c.playerId) return false;
      const keys = new Set([...Object.keys(ac), ...Object.keys(c)]);
      for (const k of keys) {
        if (k === 'clientTs') continue;
        if (JSON.stringify(ac[k]) !== JSON.stringify(c[k])) return false;
      }
      return true;
    }) ?? null
  );
}

export class LlmAgent implements GameAgent {
  readonly id: string;
  readonly label: string;
  private readonly opts: LlmAgentOptions & Required<Pick<LlmAgentOptions, 'baseUrl' | 'model'>>;
  private readonly persona: Persona;
  private readonly fallback: GameAgent;

  constructor(opts: LlmAgentOptions) {
    this.opts = { ...opts, baseUrl: opts.baseUrl, model: opts.model };
    this.persona = personaOr(opts.persona);
    this.id = `llm:${this.persona.id}${opts.idSuffix ?? ''}`;
    this.label = `AI ${this.persona.label}`;
    this.fallback = new CaboHeuristicBot();
    // fallback swapped per-decision by gameId (see decide)
  }

  async decide(obs: AgentObservation, ctx: AgentContext): Promise<AgentDecision> {
    const candidates = enumerateLegalActions(obs.view, obs.selfId);
    if (candidates.length === 0) throw new AgentError('no candidates for LLM');
    const maxCandidates = this.opts.maxCandidates ?? 200;

    const ask = async (messages: ChatMessage[]): Promise<AgentDecision> => {
      const res = await chat({
        baseUrl: this.opts.baseUrl,
        apiKey: this.opts.apiKey,
        model: this.opts.model,
        messages,
        temperature: this.opts.temperature ?? 0.4,
        maxTokens: this.opts.maxTokens ?? 400,
        timeoutMs: this.opts.timeoutMs ?? 20_000,
      });
      const parsed = extractJson(res.content);
      let matched: AnyGameAction | null = null;
      if (parsed) {
        if (typeof parsed.action_id === 'string') {
          const ref = labelCandidates(candidates, maxCandidates).find(
            (r) => r.id.toLowerCase() === parsed!.action_id!.trim().toLowerCase(),
          );
          matched = ref ? ref.action : null;
        }
        matched = matched ?? actionMatches(parsed.action, candidates);
      }
      if (!matched) throw new Error(`unusable model answer: ${res.content.slice(0, 160)}`);
      const action = matched;
      const thought = parsed ? String(parsed.thought ?? '').slice(0, 300) : undefined;
      return { action, thought: thought || undefined };
    };

    try {
      return await ask(buildLlmPrompt(obs, this.persona, candidates, { maxCandidates }));
    } catch (err) {
      // One corrective retry, feeding the error back.
      try {
        const messages = buildLlmPrompt(obs, this.persona, candidates, { maxCandidates });
        messages.push({
          role: 'assistant',
          content: `{"thought":"...","action":{}}`,
        });
        messages.push({
          role: 'user',
          content: `Your previous answer was rejected: ${String(err).slice(0, 160)}. Reply again with valid JSON choosing EXACTLY one candidate action.`,
        });
        return await ask(messages);
      } catch (retryErr) {
        if ((this.opts.mode ?? 'live-safe') === 'research-strict') {
          // Research metrics must see the failure, not a heuristic rescue.
          throw new AgentError(`strict violation: ${String(retryErr).slice(0, 200)}`);
        }
        // Live tables must never stall on the model: heuristic fallback.
        const fb =
          obs.view.gameId === 'cabo'
            ? new CaboHeuristicBot({ idSuffix: '-fb' })
            : new PairOneHeuristicBot('-fb');
        const d = fb.decide(obs, ctx);
        return { action: d.action, thought: `[fallback] ${String(retryErr).slice(0, 120)}` };
      }
    }
  }
  /** Provenance for trajectory records. */
  describe(): Record<string, unknown> {
    return {
      kind: 'llm',
      model: this.opts.model,
      baseUrl: this.opts.baseUrl,
      persona: this.persona.id,
      temperature: this.opts.temperature,
      maxTokens: this.opts.maxTokens,
      timeoutMs: this.opts.timeoutMs,
    };
  }

}
