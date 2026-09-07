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
  type AgentAttempt,
  type AgentFailureKind,
  type AgentObservation,
  type GameAgent,
} from '@game-night/agent-core';
import { CaboHeuristicBot, PairOneHeuristicBot, SeepHeuristicBot } from '@game-night/agent-bots';
import { chat, LlmHttpError, LlmResponseError, type ChatMessage } from './chat.js';
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
  /** Stable provider conversation id (required by OpenCode Go routing). */
  sessionId?: string;
  /** Optional provider label for live provenance/debug displays. */
  provider?: string;
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
  const maxCandidates = opts.maxCandidates;
  if (maxCandidates != null && candidates.length > maxCandidates) {
    throw new AgentError(`candidate budget exceeded: ${candidates.length} legal actions (limit ${maxCandidates})`);
  }
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

function buildPromptInner(obs: AgentObservation, persona: Persona, candidates: AnyGameAction[], maxCandidates?: number): ChatMessage[] {
  const refs = labelCandidates(candidates, maxCandidates);
  const aliases = new Map<string, string>();
  let aliasIndex = 0;
  const aliasFor = (value: string): string => {
    let alias = aliases.get(value);
    if (!alias) {
      alias = `card-${String.fromCharCode(65 + (aliasIndex++ % 26))}${aliasIndex > 26 ? Math.floor(aliasIndex / 26) : ''}`;
      aliases.set(value, alias);
    }
    return alias;
  };
  const publicAction = (value: unknown): unknown => {
    if (typeof value === 'string' && /^c-/.test(value)) return aliasFor(value);
    if (Array.isArray(value)) return value.map(publicAction);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, publicAction(v)]));
    return value;
  };
  const system = [
    `You are "${persona.label}", a world-class card player in a game night app.`,
    persona.prompt,
    `GAME RULES:\n${RULES_TEXT[obs.gameId]}`,
    `Respond with ONE json object and nothing else: {"thought": "<=2 sentences of provided rationale", "action_id": "<one candidate id, e.g. A7>"}. Copying the full action object as "action" instead of action_id is also acceptable. The thought is a brief explanation you provide for the move, not hidden chain-of-thought.`,
    obs.gameId === 'cabo'
      ? 'A FLUSH action is a complete move. If a flush is legal, it appears in LEGAL ACTIONS as FLUSH_OWN or FLUSH_OTHER; choose one of those candidates only when you want to flush. Never describe or submit a planned action that is not listed.'
      : '',
  ].join('\n\n');
  const user = [
    `CURRENT SITUATION (you are "YOU", id ${obs.selfId}):`,
    serializeView(obs.view, obs.selfId),
    '',
    `LEGAL ACTIONS (pick exactly one id):`,
    ...refs.map((r) => `${r.id}: ${JSON.stringify(publicAction(r.action))}`),
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

function restoreActionIds(value: unknown, aliases: Map<string, string>): unknown {
  if (typeof value === 'string') return aliases.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => restoreActionIds(item, aliases));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreActionIds(v, aliases)]));
  return value;
}

function failureKind(error: unknown): AgentFailureKind {
  if (error instanceof LlmResponseError) return error.kind;
  if (error instanceof LlmHttpError) return 'http_error';
  if (error instanceof AgentError && error.message.includes('candidate budget')) return 'candidate_budget';
  if (error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('timeout'))) return 'timeout';
  if (error instanceof Error && error.message.includes('unusable model answer')) return 'malformed_response';
  return 'provider_error';
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
  constructor(opts: LlmAgentOptions) {
    this.opts = { ...opts, baseUrl: opts.baseUrl, model: opts.model };
    this.persona = personaOr(opts.persona);
    this.id = `llm:${this.persona.id}${opts.idSuffix ?? ''}`;
    this.label = `AI ${this.persona.label}`;
  }

  async decide(obs: AgentObservation, ctx: AgentContext): Promise<AgentDecision> {
    const candidates = enumerateLegalActions(obs.view, obs.selfId);
    if (candidates.length === 0) throw new AgentError('no candidates for LLM');
    const maxCandidates = this.opts.maxCandidates;
    const attempts: AgentAttempt[] = [];
    const startedAt = Date.now();
    const aliases = new Map<string, string>();
    let aliasIndex = 0;
    for (const action of candidates) {
      const walk = (value: unknown): void => {
        if (typeof value === 'string' && /^c-/.test(value) && !aliases.has(value)) {
          const n = aliasIndex++;
          aliases.set(value, `card-${String.fromCharCode(65 + (n % 26))}${n >= 26 ? Math.floor(n / 26) : ''}`);
        } else if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') Object.values(value).forEach(walk);
      };
      walk(action);
    }
    const reverseAliases = new Map([...aliases].map(([real, alias]) => [alias, real]));
    if (maxCandidates != null && candidates.length > maxCandidates) {
      throw new AgentError(`candidate budget exceeded: ${candidates.length} legal actions (limit ${maxCandidates})`);
    }

    const ask = async (messages: ChatMessage[], attempt: number): Promise<AgentDecision> => {
      const attemptStarted = Date.now();
      try {
        const res = await chat({
        baseUrl: this.opts.baseUrl,
        apiKey: this.opts.apiKey,
        model: this.opts.model,
        messages,
        temperature: this.opts.temperature ?? 0.4,
        maxTokens: this.opts.maxTokens ?? 4_096,
        timeoutMs: this.opts.timeoutMs ?? 30_000,
        sessionId: this.opts.sessionId,
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
          matched = matched ?? actionMatches(restoreActionIds(parsed.action, reverseAliases), candidates);
      }
      if (!matched) {
        attempts.push({ attempt, status: 'failed', latencyMs: Date.now() - attemptStarted, httpStatus: res.httpStatus, finishReason: res.finishReason, promptTokens: res.usage?.promptTokens, completionTokens: res.usage?.completionTokens, failure: parsed ? 'illegal_action' : 'malformed_response' });
        throw new Error(`unusable model answer: ${res.content.slice(0, 160)}`);
      }
      const action = matched;
      const thought = parsed ? String(parsed.thought ?? '').slice(0, 300) : undefined;
      attempts.push({ attempt, status: 'accepted', latencyMs: Date.now() - attemptStarted, httpStatus: res.httpStatus, finishReason: res.finishReason, promptTokens: res.usage?.promptTokens, completionTokens: res.usage?.completionTokens });
      return {
        action,
        thought: thought || undefined,
        meta: {
          source: 'model', provider: this.opts.provider, model: this.opts.model,
          attempts, latencyMs: Date.now() - startedAt, promptTokens: res.usage?.promptTokens,
          completionTokens: res.usage?.completionTokens, candidateCount: candidates.length,
        },
      };
      } catch (err) {
        if (!attempts.some((item) => item.attempt === attempt)) {
          const details = err instanceof LlmResponseError ? err.details : undefined;
          const status = err instanceof LlmHttpError ? err.status : details?.status;
          attempts.push({ attempt, status: 'failed', latencyMs: Date.now() - attemptStarted, httpStatus: status, finishReason: details?.finishReason, promptTokens: details?.usage?.promptTokens, completionTokens: details?.usage?.completionTokens, failure: failureKind(err) });
        }
        throw err;
      }
    };

    try {
      return await ask(buildLlmPrompt(obs, this.persona, candidates, { maxCandidates }), 1);
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
        return await ask(messages, 2);
      } catch (retryErr) {
        if ((this.opts.mode ?? 'live-safe') === 'research-strict') {
          // Research metrics must see the failure, not a heuristic rescue.
          const kind = failureKind(retryErr);
          throw new AgentError(`strict violation (${kind}): ${String(retryErr).slice(0, 200)}`);
        }
        // Live tables must never stall on the model: heuristic fallback.
        const fb = obs.view.gameId === 'cabo'
          ? new CaboHeuristicBot({ idSuffix: '-fb' })
          : obs.view.gameId === 'seep'
            ? new SeepHeuristicBot({ id: `seep-fallback-${this.opts.model}` })
            : new PairOneHeuristicBot('-fb');
        const d = await fb.decide(obs, ctx);
        return {
          action: d.action,
          thought: `[fallback] ${String(retryErr).slice(0, 120)}`,
          meta: {
            source: 'fallback', provider: this.opts.provider, model: this.opts.model,
            attempts, failure: failureKind(retryErr), latencyMs: Date.now() - startedAt,
            candidateCount: candidates.length,
          },
        };
      }
    }
  }
  /** Provenance for trajectory records. */
  describe(): Record<string, unknown> {
    return {
      kind: 'llm',
      provider: this.opts.provider,
      model: this.opts.model,
      baseUrl: this.opts.baseUrl,
      persona: this.persona.id,
      temperature: this.opts.temperature,
      maxTokens: this.opts.maxTokens,
      timeoutMs: this.opts.timeoutMs,
      sessionId: this.opts.sessionId,
    };
  }

}
