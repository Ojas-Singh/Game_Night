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
 *  - a seat is played by the trained model when one is loaded and knows the
 *    game, otherwise by the built-in heuristic bot for its game;
 *  - the model plays the round in the form it was trained on (the rules
 *    core converts both ways); if it fails, the heuristic bot takes the turn;
 *  - a bot that throws, or proposes an illegal move, falls back to any
 *    engine-validated candidate.
 */
import { randomBytes } from 'node:crypto';
import type { Server as SocketServer } from 'socket.io';
import {
  enumerateLegalActions,
  createAgentRng,
  type AgentDecision,
  type GameAgent,
} from '@game-night/agent-core';
import { CaboHeuristicBot, worthFlushing, PairOneHeuristicBot, SeepHeuristicBot } from '@game-night/agent-bots';
import type { Round } from '@game-night/core';
import type { GameAction } from '@game-night/shared';
import type { AiDecisionPatch, Room } from '../room.js';
import type { ModelPlayer } from './model.js';
import { RoomError } from '../room.js';
import { log } from '../log.js';
import type { AiDecisionTrace } from '../protocol.js';

const DEFAULT_MIN_THINK_MS = 700;
const DEFAULT_MAX_THINK_MS = 2200;

export interface AgentBroadcaster {
  /** Re-broadcast lobby + game views + persist (same as human actions). */
  afterChange(room: Room): void | Promise<void>;
  /** Send host-only AI debug traces while a bot is thinking/acting. */
  aiThought?(room: Room, trace: AiDecisionTrace): void | Promise<void>;
}

export interface AgentLoopOptions {
  minThinkMs?: number;
  maxThinkMs?: number;
  /** The trained player; without it every seat is a heuristic bot. */
  model?: ModelPlayer | null;
  /** Which AI seats the model plays (all of them when left out); the rest are heuristic bots. */
  modelSeat?: (playerId: string) => boolean;
}

/** What the model needs from an engine: its round in the rules core, and the way back to table actions. */
interface CoreTable {
  readonly table: Round;
  fromCore(seat: number, move: unknown): GameAction;
}

/** Table actions made of several model moves stop here (a starting peek is one move per card). */
const MAX_MODEL_MOVES = 16;

export class AgentLoops {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private agents = new Map<string, GameAgent>(); // roomId:playerId → agent
  private engineRefs = new Map<string, object>();
  private busy = new Set<string>();
  /** At most one interrupt runs per room; normal AI thinking may overlap it. */
  private flushBusy = new Set<string>();
  private readonly minThinkMs: number;
  private readonly maxThinkMs: number;
  private model: ModelPlayer | null;
  private readonly modelSeat: (playerId: string) => boolean;
  /** roomId:playerId → the situation the model was last asked about flushing in. */
  private flushAsked = new Map<string, string>();

  constructor(
    private io: SocketServer,
    private broadcaster: AgentBroadcaster,
    opts: AgentLoopOptions = {},
  ) {
    this.minThinkMs = opts.minThinkMs ?? DEFAULT_MIN_THINK_MS;
    this.maxThinkMs = opts.maxThinkMs ?? DEFAULT_MAX_THINK_MS;
    this.model = opts.model ?? null;
    this.modelSeat = opts.modelSeat ?? (() => true);
  }

  /** Seat AI players with this model from now on (null: heuristic bots). */
  setModel(model: ModelPlayer | null): void {
    this.model = model;
  }

  /** The room's game as the model plays it, when a model is loaded and knows the game. */
  private coreTable(room: Room): CoreTable | null {
    const engine = room.engine as Partial<CoreTable> | null;
    if (!this.model || !engine || typeof engine.fromCore !== 'function' || !this.model.plays(room.gameId)) return null;
    return engine as CoreTable;
  }

  private seatOf(room: Room, playerId: string): number {
    const state = room.engine!.getState() as { players: Array<{ id: string }> };
    return state.players.findIndex((player) => player.id === playerId);
  }

  /**
   * What a flush decision depends on: the card on the discard pile and how
   * many cards the seat knows. The model is asked once each time it changes.
   */
  private flushSituation(room: Room, playerId: string): string | null {
    const view = room.gameView(playerId, { forAi: true }) as
      | { gameId: string; knownCards?: Record<string, unknown> }
      | null;
    if (!view || view.gameId !== 'cabo') return null;
    const discard = (room.engine!.getState() as { discard: Array<{ id: string }> }).discard;
    return `${discard.length}:${discard.at(-1)?.id ?? ''}:${Object.keys(view.knownCards ?? {}).length}`;
  }

  /** An AI seat the model has not yet been asked about flushing in the present situation. */
  private modelFlushToAsk(room: Room, core: CoreTable): string | null {
    if (room.gameId !== 'cabo') return null;
    for (const player of room.players.values()) {
      if (player.kind !== 'ai' || !this.modelSeat(player.id)) continue;
      const situation = this.flushSituation(room, player.id);
      if (situation === null || this.flushAsked.get(`${room.id}:${player.id}`) === situation) continue;
      const asked = core.table.forSeat(this.seatOf(room, player.id), true, 0);
      if (!asked) continue;
      asked.free();
      return player.id;
    }
    return null;
  }

  private async publishTrace(room: Room, trace: AiDecisionTrace | null): Promise<void> {
    if (trace) await this.broadcaster.aiThought?.(room, trace);
  }

  private traceMeta(meta: AgentDecision['meta']): AiDecisionPatch {
    return {
      ...(meta?.latencyMs != null ? { latencyMs: meta.latencyMs } : {}),
      ...(meta?.failure ? { failure: meta.failure } : {}),
      ...(meta?.source ? { decisionSource: meta.source } : {}),
    };
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
    // The model is asked about a flush at once and waits before acting only
    // if it takes one: most asks end in "no", and should not hold the table up.
    const delay =
      flushAiId && this.coreTable(room) && this.modelSeat(flushAiId)
        ? Math.min(50, this.minThinkMs)
        : this.minThinkMs + Math.floor(Math.random() * (this.maxThinkMs - this.minThinkMs));
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
    if (!engine) return null;
    const core = this.coreTable(room);
    if (core) {
      const asked = this.modelFlushToAsk(room, core);
      if (asked) return asked;
    }
    const state = engine.getState() as { phase: string };
    if (state.phase === 'INITIAL_PEEK' || state.phase === 'ROUND_REVEAL' || state.phase === 'ROUND_COMPLETE') return null;
    for (const player of room.players.values()) {
      if (player.kind !== 'ai' || (core && this.modelSeat(player.id))) continue;
      const view = room.gameView(player.id, { forAi: true });
      if (!view || view.gameId !== 'cabo') continue;
      const flushes = enumerateLegalActions(view, player.id).filter(
        (action) => (action.type === 'FLUSH_OWN' || action.type === 'FLUSH_OTHER') && worthFlushing(view, action),
      );
      if (flushes.some((action) => engine.validateAction(action))) return player.id;
    }
    return null;
  }

  private aiToAct(room: Room): string | null {
    const engine = room.engine!;
    const s = engine.getState() as {
      phase: string;
      players: Array<{ id: string }>;
      currentTurn: number;
      initialPeeksRemaining?: string[];
      pendingTransfer?: { fromPlayerId: string } | null;
      pendingTransfers?: Array<{ fromPlayerId: string }>;
      hands?: Record<string, Array<unknown | null>>;
    };
    if (s.phase === 'ROUND_COMPLETE' || s.phase === 'ROUND_REVEAL') return null;
    let who: string | null;
    if (s.phase === 'TRANSFER_PENDING') {
      const pending = s.pendingTransfers ?? (s.pendingTransfer ? [s.pendingTransfer] : []);
      // The first player who still has a card to hand over pays first; one left without cards owes nothing.
      const canPay = (id: string): boolean => (s.hands?.[id] ?? [null]).some((card) => card != null) || !s.hands;
      const payer = pending.find((transfer) => canPay(transfer.fromPlayerId))?.fromPlayerId;
      who = payer && room.players.get(payer)?.kind === 'ai' ? payer : null;
    }
    else if (s.phase === 'INITIAL_PEEK') who = s.initialPeeksRemaining?.[0] ?? null;
    else who = s.players[s.currentTurn]?.id ?? null;
    if (!who) return null;
    const p = room.players.get(who);
    return p?.kind === 'ai' ? who : null;
  }

  private agentFor(room: Room, playerId: string): GameAgent {
    const key = `${room.id}:${playerId}`;
    const existing = this.agents.get(key);
    if (existing) return existing;
    const agent: GameAgent =
      room.gameId === 'cabo'
        ? new CaboHeuristicBot({ idSuffix: `:${room.id.slice(0, 4)}` })
        : room.gameId === 'seep'
          ? new SeepHeuristicBot()
          : new PairOneHeuristicBot(`:${room.id.slice(0, 4)}`);
    // Bound memory: drop stale entries when the map gets long.
    if (this.agents.size > 512) this.agents.clear();
    this.agents.set(key, agent);
    return agent;
  }

  /**
   * Let the model play this decision. Returns false when it could not, and
   * the heuristic bot should take the turn instead. A flush ask always
   * counts as handled: "no flush" is an answer.
   */
  private async actWithModel(room: Room, core: CoreTable, aiId: string, interruptOnly: boolean): Promise<boolean> {
    const model = this.model!;
    const view = room.gameView(aiId, { forAi: true });
    const seat = this.seatOf(room, aiId);
    if (!view || seat < 0) return false;
    if (interruptOnly) {
      if (this.flushAsked.size > 4096) this.flushAsked.clear();
      this.flushAsked.set(`${room.id}:${aiId}`, this.flushSituation(room, aiId) ?? '');
    }
    const decisionRevision = view.revision;
    const decisionEngine = room.engine;
    const seed = randomBytes(4).readUInt32BE(0);
    const agent = { kind: 'Model', label: 'trained player' };
    // A turn shows as "thinking" while the model works; a flush ask shows only if it flushes.
    let trace = interruptOnly ? null : room.beginAiDecision(aiId, agent);
    await this.publishTrace(room, trace);
    const fail = async (failure: string, summary: string): Promise<void> => {
      const failed = trace ? room.updateAiDecision(trace.id, { status: 'failed', summary, failure, decisionSource: 'model' }) : null;
      await this.publishTrace(room, failed);
    };
    const started = Date.now();
    let move: unknown = null;
    let rationale: string[] = [];
    try {
      const round = core.table.forSeat(seat, interruptOnly, seed);
      if (!round) {
        await fail('no_decision', 'The model had no decision to make here.');
        return interruptOnly;
      }
      try {
        for (let moves = 0; ; moves += 1) {
          if (moves >= MAX_MODEL_MOVES) throw new Error('the model did not finish its action');
          const choice = await model.choose(round, (seed + moves) >>> 0);
          const legal = JSON.parse(round.legal()) as Array<{ type?: string } | string>;
          const name = (i: number): string => {
            const one = legal[i];
            return typeof one === 'string' ? one : JSON.stringify(one);
          };
          rationale = choice.policy
            .map((p, i) => ({ p, i }))
            .sort((a, b) => b.p - a.p)
            .slice(0, 4)
            .map(({ p, i }) => {
              const value = choice.values.length ? `, value ${choice.values[i]!.toFixed(2)}` : '';
              return `${i === choice.index ? '→ ' : ''}${name(i)}: ${(100 * p).toFixed(0)}%${value}`;
            });
          const step = JSON.parse(round.atTable(choice.index)) as { action: unknown; more: boolean };
          if (!step.more) {
            move = step.action;
            break;
          }
          round.step(choice.index);
        }
      } finally {
        round.free();
      }
    } catch (err) {
      log.warn('ai_model_error', { roomId: room.id, aiId, error: String(err).slice(0, 160) });
      await fail('agent_error', 'The model failed; the heuristic bot takes this decision.');
      return interruptOnly;
    }
    if (move === null) {
      // Out of turn the model may decline to act; in turn there is always a move.
      if (!interruptOnly) await fail('no_decision', 'The model chose no action.');
      return interruptOnly;
    }
    const stale = async (): Promise<boolean> => {
      const latest = room.gameView(aiId, { forAi: true });
      if (room.engine === decisionEngine && latest && latest.revision === decisionRevision) return false;
      await fail('stale_decision', 'The table changed while this decision was being prepared; the proposed move was discarded.');
      // Asked again from the new position by the next notification.
      if (interruptOnly) this.flushAsked.delete(`${room.id}:${aiId}`);
      return true;
    };
    // The move names positions at the table it was chosen for; at a changed table they may hold other cards.
    if (await stale()) return true;
    let action: GameAction;
    try {
      action = core.fromCore(seat, move);
    } catch (err) {
      log.warn('ai_model_error', { roomId: room.id, aiId, error: String(err).slice(0, 160) });
      await fail('illegal_action', 'The model\'s move could not be played at this table.');
      return interruptOnly;
    }
    if (interruptOnly) {
      trace = room.beginAiDecision(aiId, agent);
      await this.publishTrace(room, trace);
      // A person needs a moment to see the card and reach for theirs.
      const reaction = (this.minThinkMs + Math.random() * (this.maxThinkMs - this.minThinkMs)) / 2;
      await new Promise((resolve) => setTimeout(resolve, reaction));
    }
    const latencyMs = Date.now() - started;
    const decided = trace
      ? room.updateAiDecision(trace.id, {
          status: 'decision',
          summary: 'Chosen by the trained player after looking ahead.',
          rationale,
          proposedAction: action.type,
          decisionSource: 'model',
          latencyMs,
        })
      : null;
    await this.publishTrace(room, decided);
    if (await stale()) return true;
    try {
      room.handleGameAction(aiId, action);
    } catch (err) {
      if (!(err instanceof RoomError)) throw err;
      log.warn('ai_model_refused', { roomId: room.id, aiId, type: action.type, error: err.message.slice(0, 160) });
      await fail('illegal_action', 'The table refused the model\'s move.');
      return interruptOnly;
    }
    const executed = trace
      ? room.updateAiDecision(trace.id, { status: 'executed', executedAction: action.type, decisionSource: 'model', latencyMs })
      : null;
    await this.publishTrace(room, executed);
    await this.broadcaster.afterChange(room);
    log.debug('ai_action', { roomId: room.id, aiId, type: action.type, source: 'model' });
    return true;
  }

  private async act(room: Room, aiId: string, interruptOnly = false): Promise<void> {
    const guard = `${room.id}`;
    let activeTrace: AiDecisionTrace | null = null;
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
      const core = this.coreTable(room);
      if (core && this.modelSeat(aiId) && (await this.actWithModel(room, core, aiId, interruptOnly))) return;
      // Test Mode is a human debugging aid. AI seats always receive their
      // normal filtered view, otherwise the host's reveal switch becomes a
      // hidden-information leak.
      const view = room.gameView(aiId, { forAi: true });
      if (!view) return;
      const decisionRevision = view.revision;
      const decisionEngine = room.engine;
      const obs = { gameId: view.gameId, selfId: aiId, view, step: 0 };
      const allCandidates = enumerateLegalActions(view, aiId);
      const legalCandidates = interruptOnly
        ? allCandidates.filter(
            (action) => (action.type === 'FLUSH_OWN' || action.type === 'FLUSH_OTHER') && (view.gameId !== 'cabo' || worthFlushing(view, action)),
          )
        : allCandidates;
      if (legalCandidates.length === 0) return;
      const rng = createAgentRng(randomBytes(4).readUInt32BE(0));
      let action;
      let decisionMeta: import('@game-night/agent-core').AgentDecision['meta'];
      const agent = this.agentFor(room, aiId);
      const trace = room.beginAiDecision(aiId, agent);
      activeTrace = trace;
      await this.publishTrace(room, trace);
      try {
        const decision = await agent.decide(obs, { rng, allowedActions: legalCandidates, interruptOnly });
        action = decision.action;
        decisionMeta = decision.meta;
        const decided = trace
          ? room.updateAiDecision(trace.id, {
              status: 'decision',
              summary: decision.thought ?? 'Selected a legal move.',
              rationale: decision.rationale,
              // A fallback action is executed but was not proposed by the
              // agent; keep the two distinguishable in the inspector.
              proposedAction: decision.meta?.source === 'fallback' ? undefined : action.type,
              observation: JSON.stringify(view),
              candidates: legalCandidates.map((candidate) => JSON.stringify(candidate)),
              ...this.traceMeta(decision.meta),
            })
          : null;
        await this.publishTrace(room, decided);
      } catch (err) {
        log.warn('ai_agent_error', { roomId: room.id, aiId, error: String(err).slice(0, 120) });
      }
      if (!action) {
        action = rng.pick(legalCandidates);
        decisionMeta = {
          ...(decisionMeta ?? {}),
          source: 'fallback',
          failure: 'agent_error',
        };
        const fallback = trace
          ? room.updateAiDecision(trace.id, {
              status: 'decision',
              summary: 'The agent failed; selected a safe legal fallback.',
              proposedAction: undefined,
              ...this.traceMeta(decisionMeta),
            })
          : null;
        await this.publishTrace(room, fallback);
      }
      // A decision is asynchronous. The room may have been restarted,
      // the seat may have changed, or a newer command may have advanced the
      // revision while it was thinking. Never submit a stale flush (or any
      // other move) against a newer information state.
      const latestView = room.gameView(aiId, { forAi: true });
      if (room.engine !== decisionEngine || !latestView || latestView.revision !== decisionRevision) {
        const discarded = trace
          ? room.updateAiDecision(trace.id, {
              status: 'failed',
              summary: 'The table changed while this decision was being prepared; the proposed move was discarded.',
              failure: 'stale_decision',
              decisionSource: 'discarded',
            })
          : null;
        await this.publishTrace(room, discarded);
        return;
      }
      const proposedAction = action;
      try {
        room.handleGameAction(aiId, action);
      } catch (err) {
        if (!(err instanceof RoomError)) throw err;
        // Illegal proposal: submit any engine-validated candidate.
        const legal = legalCandidates.filter((a) => room.engine?.validateAction(a));
        if (legal.length === 0) {
          const failed = trace
            ? room.updateAiDecision(trace.id, {
                status: 'failed',
                summary: 'The proposed move was rejected and no legal fallback remained.',
                proposedAction: proposedAction.type,
                failure: 'no_legal_fallback',
                decisionSource: 'fallback',
              })
            : null;
          await this.publishTrace(room, failed);
          return;
        }
        const fallbackAction = rng.pick(legal);
        action = fallbackAction;
        decisionMeta = { ...(decisionMeta ?? {}), source: 'fallback', failure: 'illegal_action' };
        const repaired = trace
          ? room.updateAiDecision(trace.id, {
              status: 'decision',
              summary: 'The proposed move was rejected; selected a legal fallback.',
              proposedAction: proposedAction.type,
              ...this.traceMeta(decisionMeta),
            })
          : null;
        await this.publishTrace(room, repaired);
        room.handleGameAction(aiId, fallbackAction);
      }
      const executed = trace
        ? room.updateAiDecision(trace.id, {
            status: 'executed',
            executedAction: action.type,
            decisionSource: decisionMeta?.source ?? 'heuristic',
            ...this.traceMeta(decisionMeta),
          })
        : null;
      // The engine has accepted the command. Transport/persistence errors
      // after this point must not rewrite an authoritative execution as a
      // failed decision.
      activeTrace = null;
      await this.publishTrace(room, executed);
      await this.broadcaster.afterChange(room);
      log.debug('ai_action', { roomId: room.id, aiId, type: action.type });
    } catch (err) {
      if (activeTrace) {
        const failed = room.updateAiDecision(activeTrace.id, {
          status: 'failed',
          summary: 'The AI decision could not be completed.',
          failure: 'agent_loop_error',
          decisionSource: 'failed',
        });
        await this.publishTrace(room, failed);
      }
      log.error('ai_loop_error', { roomId: room.id, error: String(err).slice(0, 160) });
    } finally {
      if (interruptOnly) this.flushBusy.delete(guard);
      else this.busy.delete(guard);
      // Chain: same player continues (pairone match) or next AI turn.
      this.notify(room);
    }
  }
}
