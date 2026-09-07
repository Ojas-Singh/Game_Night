/**
 * AgentLoops — drives AI seats in live rooms.
 *
 * After every room change the socket layer calls notify(room); the loop
 * checks for Cabo flush interrupts before normal turns, waits a human-ish
 * think delay, asks its agent for a decision, and submits it through the SAME
 * authority path as humans (Room.handleGameAction). Engines never learn
 * they are playing against machines.
 *
 * Guarantees:
 *  - one pending timer per room (re-entrant notifications collapse);
 *  - the server NEVER blocks on an LLM: bounded HTTP timeout + heuristic
 *    fallback on any failure;
 *  - illegal proposals fall back to any engine-validated candidate;
 *  - works without AGENT_API_URL (heuristic bots only).
 */
import { RuleZeroEngine } from '../rulezeroEngine.js';

import { randomBytes } from 'node:crypto';
import type { Server as SocketServer } from 'socket.io';
import {
  enumerateLegalActions,
  createAgentRng,
  type GameAgent,
} from '@game-night/agent-core';
import { CaboHeuristicBot, PairOneHeuristicBot, SeepHeuristicBot } from '@game-night/agent-bots';
import { LlmAgent } from '@game-night/agent-llm';
import type { Room } from '../room.js';
import { RoomError } from '../room.js';
import { config } from '../config.js';
import { log } from '../log.js';
import type { AiThought } from '../protocol.js';

const DEFAULT_MIN_THINK_MS = 700;
const DEFAULT_MAX_THINK_MS = 2200;

export interface AgentBroadcaster {
  /** Re-broadcast lobby + game views + persist (same as human actions). */
  afterChange(room: Room): void | Promise<void>;
  /** Send host-only AI debug traces while a model is thinking/acting. */
  aiThought?(room: Room, thought: AiThought): void | Promise<void>;
}

export interface AgentLoopOptions {
  minThinkMs?: number;
  maxThinkMs?: number;
}

export class AgentLoops {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private agents = new Map<string, GameAgent>(); // roomId:playerId → agent
  private engineRefs = new Map<string, object>();
  private engineEpoch = new Map<string, number>();
  private busy = new Set<string>();
  /** At most one interrupt runs per room; normal AI thinking may overlap it. */
  private flushBusy = new Set<string>();
  private readonly minThinkMs: number;
  private readonly maxThinkMs: number;

  constructor(
    private io: SocketServer,
    private broadcaster: AgentBroadcaster,
    opts: AgentLoopOptions = {},
  ) {
    this.minThinkMs = opts.minThinkMs ?? DEFAULT_MIN_THINK_MS;
    this.maxThinkMs = opts.maxThinkMs ?? DEFAULT_MAX_THINK_MS;
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.flushBusy.clear();
  }

  /** Call after ANY room mutation. Cheap; collapses to one timer per room. */
  notify(room: Room): void {
    if (room.engine && this.engineRefs.get(room.id) !== room.engine) {
      for (const key of this.agents.keys()) if (key.startsWith(`${room.id}:`)) this.agents.delete(key);
      this.engineRefs.set(room.id, room.engine);
      this.engineEpoch.set(room.id, (this.engineEpoch.get(room.id) ?? 0) + 1);
    }
    const prev = this.timers.get(room.id);
    if (prev) clearTimeout(prev);
    this.timers.delete(room.id);
    if (room.closed || !room.engine || room.engine.isGameFinished()) return;
    // Cabo flushes are legal interrupts even when another seat owns the
    // normal turn. Give those known opportunities priority over turn play.
    const flushAiId = this.aiFlushToAct(room);
    if (flushAiId && this.flushBusy.has(room.id)) return;
    if (!flushAiId && this.busy.has(room.id)) return;
    const aiId = flushAiId ?? this.aiToAct(room);
    if (!aiId) return;
    const delay = this.minThinkMs + Math.floor(Math.random() * (this.maxThinkMs - this.minThinkMs));
    const timer = setTimeout(() => {
      this.timers.delete(room.id);
      void this.act(room, aiId, Boolean(flushAiId));
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(room.id, timer);
  }

  /**
   * Find an AI that can submit a known Cabo flush right now. The Cabo engine
   * intentionally permits FLUSH_OWN/FLUSH_OTHER in every live phase without
   * requiring the flusher to own currentTurn, so this path must not wait for
   * that seat's ordinary turn.
   */
  private aiFlushToAct(room: Room): string | null {
    const engine = room.engine;
    if (!engine || engine instanceof RuleZeroEngine) return null;
    const state = engine.getState() as { phase: string };
    if (state.phase === 'INITIAL_PEEK' || state.phase === 'ROUND_REVEAL' || state.phase === 'ROUND_COMPLETE') return null;
    for (const player of room.players.values()) {
      if (player.kind !== 'ai') continue;
      const view = room.gameView(player.id, { forAi: true });
      if (!view || view.gameId !== 'cabo') continue;
      const flushes = enumerateLegalActions(view, player.id).filter(
        (action) => action.type === 'FLUSH_OWN' || action.type === 'FLUSH_OTHER',
      );
      if (flushes.some((action) => engine.validateAction(action))) return player.id;
    }
    return null;
  }

  private aiToAct(room: Room): string | null {
    const engine = room.engine!;
    if (engine instanceof RuleZeroEngine) {
      // Service-backed games: the engine reports its own actor, but applies
      // settle asynchronously, so schedule a polling pump whenever an AI
      // seat exists (actRulezero waits for the service + turn).
      const hasAi = [...room.players.values()].some((p) => p.kind === 'ai');
      if (hasAi) {
        const t = setTimeout(() => {
          this.timers.delete(room.id);
          void this.actRulezero(room);
        }, this.minThinkMs);
        if (typeof t.unref === 'function') t.unref();
        this.timers.set(room.id, t);
      }
      return null;
    }
    const s = engine.getState() as {
      phase: string;
      players: Array<{ id: string }>;
      currentTurn: number;
      initialPeeksRemaining?: string[];
      pendingTransfer?: { fromPlayerId: string } | null;
      pendingTransfers?: Array<{ fromPlayerId: string }>;
    };
    if (s.phase === 'ROUND_COMPLETE' || s.phase === 'ROUND_REVEAL') return null;
    let who: string | null;
    if (s.phase === 'TRANSFER_PENDING') {
      const pending = s.pendingTransfers ?? (s.pendingTransfer ? [s.pendingTransfer] : []);
      who = pending.find((transfer) => room.players.get(transfer.fromPlayerId)?.kind === 'ai')?.fromPlayerId ?? null;
    }
    else if (s.phase === 'INITIAL_PEEK') who = s.initialPeeksRemaining?.[0] ?? null;
    else who = s.players[s.currentTurn]?.id ?? null;
    if (!who) return null;
    const p = room.players.get(who);
    return p?.kind === 'ai' ? who : null;
  }

  /**
   * RuleZero seats act inside the python service: ask it to pick for the
   * given AI player (CFR or random), then submit through the SAME room
   * authority path as humans. Chance steps resolve internally (-1).
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Polling pump for RuleZero rooms: wait for the service session, then
   * while it is an AI seat's turn ask the python service for a move
   * (CFR or random) and submit through the SAME authority path as humans.
   * Chance steps resolve inside the service (-1 sentinel).
   */
  private async actRulezero(room: Room): Promise<void> {
    const guard = `${room.id}`;
    if (this.busy.has(guard)) return;
    this.busy.add(guard);
    try {
      const engine = room.engine;
      if (!(engine instanceof RuleZeroEngine) || engine.isGameFinished()) return;
      const aiIds = [...room.players.values()]
        .filter((p) => p.kind === 'ai')
        .map((p) => p.id);
      const solver = {
        label: 'RuleZero AI',
        describe: () => ({ kind: 'solver', model: 'CFR / random OpenSpiel seat' }),
      };

      for (let attempt = 0; attempt < 24; attempt++) {
        if (room.closed || engine.isGameFinished()) return;
        const actor = await engine.currentPlayerId();
        if (!actor) {
          // Service still spawning or between phases — retry shortly.
          await this.sleep(500);
          continue;
        }
        if (!aiIds.includes(actor)) return; // humans turn — done pumping
        const thinking = room.recordAiThought(actor, solver, 'thinking', 'Evaluating the legal actions from the current information state…');
        if (thinking) await this.broadcaster.aiThought?.(room, thinking);
        const pick = await engine.chooseAiAction(actor);
        if (pick === null) return;
        const trace = room.recordAiThought(
          actor,
          solver,
          'decision',
          pick === -1 ? 'The solver advanced the service through a chance step.' : 'The solver selected a legal action from the service policy.',
          pick === -1 ? 'CHANCE' : `ACTION_${pick}`,
        );
        if (trace) await this.broadcaster.aiThought?.(room, trace);
        if (pick === -1) continue; // chance resolved; keep pumping
        await room.runCommand(async () => {
          if (room.engine !== engine) return;
          await room.applyGameAction(actor, { type: 'RZ_APPLY', playerId: actor,
            actionIndex: pick, expectedRevision: engine.getState().snapshot.revision,
            commandId: randomBytes(16).toString('hex') } as any);
          await this.broadcaster.afterChange(room);
        });
        await this.sleep(200);
      }
    } catch (err) {
      log.error('ai_loop_error', { roomId: room.id, error: String(err).slice(0, 160) });
    } finally {
      this.busy.delete(guard);
    }
  }

  private agentFor(room: Room, playerId: string): GameAgent {
    const key = `${room.id}:${playerId}`;
    const existing = this.agents.get(key);
    if (existing) return existing;
    let agent: GameAgent;
    if (config.agentApiUrl && (room.gameId === 'cabo' || room.gameId === 'pairone' || room.gameId === 'seep')) {
      const configuredModel = config.agentModel.startsWith('opencode-go/')
        ? config.agentModel.slice('opencode-go/'.length)
        : config.agentModel;
      agent = new LlmAgent({
        baseUrl: config.agentApiUrl,
        apiKey: config.agentApiKey || undefined,
        model: configuredModel,
        persona: room.players.get(playerId)?.persona,
        idSuffix: `:${room.id.slice(0, 4)}`,
        timeoutMs: config.agentTimeoutMs,
        maxTokens: config.agentMaxTokens,
        maxCandidates: config.agentMaxCandidates,
        sessionId: config.agentProvider === 'opencode-go'
          ? `room-${room.id}-match-${this.engineEpoch.get(room.id) ?? 0}-seat-${playerId}`
          : undefined,
        provider: config.agentProvider,
      });
    } else {
      agent =
        room.gameId === 'cabo'
          ? new CaboHeuristicBot({
              idSuffix: `:${room.id.slice(0, 4)}`,
              persona: room.players.get(playerId)?.persona,
            })
          : room.gameId === 'seep'
            ? new SeepHeuristicBot({ persona: room.players.get(playerId)?.persona })
            : new PairOneHeuristicBot(`:${room.id.slice(0, 4)}`);
    }
    // Bound memory: drop stale entries when the map gets long.
    if (this.agents.size > 512) this.agents.clear();
    this.agents.set(key, agent);
    return agent;
  }

  private async act(room: Room, aiId: string, interruptOnly = false): Promise<void> {
    const guard = `${room.id}`;
    if (interruptOnly) {
      if (this.flushBusy.has(guard)) return;
      this.flushBusy.add(guard);
    } else {
      // A newly discovered flush always preempts normal turn thinking. The
      // normal response will be revision-checked and discarded if necessary.
      if (this.aiFlushToAct(room)) {
        this.notify(room);
        return;
      }
      if (this.busy.has(guard)) {
        this.notify(room);
        return;
      }
      this.busy.add(guard);
    }
    try {
      if (!room.engine || room.engine.isGameFinished()) return;
      // Test Mode is a human debugging aid. AI seats always receive their
      // normal filtered view, otherwise the host's reveal switch becomes a
      // hidden-information leak and invalidates model evaluation.
      const view = room.gameView(aiId, { forAi: true });
      if (!view) return;
      if (view.gameId === 'rulezero') return; // service games: human seats only (for now)
      const decisionRevision = view.revision;
      const decisionEngine = room.engine;
      const obs = { gameId: view.gameId, selfId: aiId, view, step: 0 };
      const allCandidates = enumerateLegalActions(view, aiId);
      const legalCandidates = interruptOnly
        ? allCandidates.filter((action) => action.type === 'FLUSH_OWN' || action.type === 'FLUSH_OTHER')
        : allCandidates;
      if (legalCandidates.length === 0) return;
      const rng = createAgentRng(randomBytes(4).readUInt32BE(0));
      let action;
      let decisionMeta: import('@game-night/agent-core').AgentDecision['meta'];
      const agent = this.agentFor(room, aiId);
      const thinking = room.recordAiThought(
        aiId,
        agent,
        'thinking',
        interruptOnly ? 'Known flush opportunity detected; choosing an interrupt action…' : 'Reviewing the visible table…',
      );
      if (thinking) await this.broadcaster.aiThought?.(room, thinking);
      try {
        const decision = await agent.decide(obs, { rng, allowedActions: legalCandidates, interruptOnly });
        action = decision.action;
        decisionMeta = decision.meta;
        const trace = room.recordAiThought(aiId, agent, 'decision', decision.thought ?? 'Selected a legal move.', action.type, {
          decisionSource: decision.meta?.source,
          failure: decision.meta?.failure,
          latencyMs: decision.meta?.latencyMs,
          attempts: decision.meta?.attempts?.length,
          rationale: decision.rationale,
          providerReasoningAvailable: decision.meta?.providerReasoningAvailable,
          observation: JSON.stringify(view),
          candidates: legalCandidates.map((candidate) => JSON.stringify(candidate)),
        });
        if (trace) await this.broadcaster.aiThought?.(room, trace);
      } catch (err) {
        const trace = room.recordAiThought(aiId, agent, 'failed', `The agent failed, so the table used a safe fallback: ${String(err).slice(0, 180)}`, undefined, { failure: 'agent_error', decisionSource: 'fallback' });
        if (trace) await this.broadcaster.aiThought?.(room, trace);
        log.warn('ai_agent_error', { roomId: room.id, aiId, error: String(err).slice(0, 120) });
      }
      if (!action) {
        action = rng.pick(legalCandidates);
      }
      // An LLM response is asynchronous. The room may have been restarted,
      // the seat may have changed, or a newer command may have advanced the
      // revision while it was thinking. Never submit a stale flush (or any
      // other move) against a newer information state.
      const latestView = room.gameView(aiId, { forAi: true });
      if (room.engine !== decisionEngine || !latestView || latestView.gameId === 'rulezero' || latestView.revision !== decisionRevision) {
        const discarded = room.recordAiThought(
          aiId,
          agent,
          'failed',
          'The table changed while this decision was being prepared; the proposed move was discarded.',
          undefined,
          { failure: 'stale_decision', decisionSource: 'discarded' },
        );
        if (discarded) await this.broadcaster.aiThought?.(room, discarded);
        return;
      }
      try {
        room.handleGameAction(aiId, action);
      } catch (err) {
        if (!(err instanceof RoomError)) throw err;
        // Illegal proposal (LLM drift): submit any engine-validated candidate.
        const legal = legalCandidates.filter((a) => room.engine?.validateAction(a));
        if (legal.length === 0) return;
        const fallbackAction = rng.pick(legal);
        action = fallbackAction;
        decisionMeta = { ...(decisionMeta ?? {}), source: 'fallback', failure: 'illegal_action' };
        room.handleGameAction(aiId, fallbackAction);
      }
      const executed = room.recordAiThought(aiId, agent, 'executed', `Executed ${action.type} after authoritative validation.`, action.type, {
        executedAction: action.type,
        decisionSource: decisionMeta?.source ?? 'heuristic',
        failure: decisionMeta?.failure,
        latencyMs: decisionMeta?.latencyMs,
        attempts: decisionMeta?.attempts?.length,
      });
      if (executed) await this.broadcaster.aiThought?.(room, executed);
      this.broadcaster.afterChange(room);
      log.debug('ai_action', { roomId: room.id, aiId, type: action.type });
    } catch (err) {
      log.error('ai_loop_error', { roomId: room.id, error: String(err).slice(0, 160) });
    } finally {
      if (interruptOnly) this.flushBusy.delete(guard);
      else this.busy.delete(guard);
      // Chain: same player continues (pairone match) or next AI turn.
      this.notify(room);
    }
  }
}
