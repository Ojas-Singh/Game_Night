/**
 * AgentLoops — drives AI seats in live rooms.
 *
 * After every room change the socket layer calls notify(room); the loop
 * checks whether the seat that must act is an AI, waits a human-ish think
 * delay, asks its agent for a decision, and submits it through the SAME
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

import { randomBytes } from 'node:crypto';
import type { Server as SocketServer } from 'socket.io';
import {
  enumerateLegalActions,
  createAgentRng,
  type GameAgent,
} from '@game-night/agent-core';
import { CaboHeuristicBot, PairOneHeuristicBot } from '@game-night/agent-bots';
import { LlmAgent } from '@game-night/agent-llm';
import type { Room } from '../room.js';
import { RoomError } from '../room.js';
import { config } from '../config.js';
import { log } from '../log.js';

const DEFAULT_MIN_THINK_MS = 700;
const DEFAULT_MAX_THINK_MS = 2200;

export interface AgentBroadcaster {
  /** Re-broadcast lobby + game views + persist (same as human actions). */
  afterChange(room: Room): void;
}

export interface AgentLoopOptions {
  minThinkMs?: number;
  maxThinkMs?: number;
}

export class AgentLoops {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private agents = new Map<string, GameAgent>(); // roomId:playerId → agent
  private busy = new Set<string>();
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
  }

  /** Call after ANY room mutation. Cheap; collapses to one timer per room. */
  notify(room: Room): void {
    const prev = this.timers.get(room.id);
    if (prev) clearTimeout(prev);
    this.timers.delete(room.id);
    if (room.closed || !room.engine || room.engine.isGameFinished()) return;
    const aiId = this.aiToAct(room);
    if (!aiId) return;
    const delay = this.minThinkMs + Math.floor(Math.random() * (this.maxThinkMs - this.minThinkMs));
    const timer = setTimeout(() => {
      this.timers.delete(room.id);
      void this.act(room, aiId);
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(room.id, timer);
  }

  private aiToAct(room: Room): string | null {
    const engine = room.engine!;
    const s = engine.getState() as {
      phase: string;
      players: Array<{ id: string }>;
      currentTurn: number;
      initialPeeksRemaining?: string[];
    };
    if (s.phase === 'ROUND_COMPLETE' || s.phase === 'ROUND_REVEAL') return null;
    let who: string | null;
    if (s.phase === 'INITIAL_PEEK') who = s.initialPeeksRemaining?.[0] ?? null;
    else who = s.players[s.currentTurn]?.id ?? null;
    if (!who) return null;
    const p = room.players.get(who);
    return p?.kind === 'ai' ? who : null;
  }

  private agentFor(room: Room, playerId: string): GameAgent {
    const key = `${room.id}:${playerId}`;
    const existing = this.agents.get(key);
    if (existing) return existing;
    let agent: GameAgent;
    if (config.agentApiUrl && room.gameId === 'cabo') {
      agent = new LlmAgent({
        baseUrl: config.agentApiUrl,
        apiKey: config.agentApiKey || undefined,
        model: config.agentModel,
        persona: room.players.get(playerId)?.persona,
        idSuffix: `:${room.id.slice(0, 4)}`,
        timeoutMs: 15_000,
      });
    } else {
      agent =
        room.gameId === 'cabo'
          ? new CaboHeuristicBot({ idSuffix: `:${room.id.slice(0, 4)}` })
          : new PairOneHeuristicBot(`:${room.id.slice(0, 4)}`);
    }
    // Bound memory: drop stale entries when the map gets long.
    if (this.agents.size > 512) this.agents.clear();
    this.agents.set(key, agent);
    return agent;
  }

  private async act(room: Room, aiId: string): Promise<void> {
    const guard = `${room.id}`;
    if (this.busy.has(guard)) {
      this.notify(room);
      return;
    }
    this.busy.add(guard);
    try {
      if (!room.engine || room.engine.isGameFinished()) return;
      const view = room.gameView(aiId);
      if (!view) return;
      const obs = { gameId: view.gameId as 'cabo' | 'pairone', selfId: aiId, view, step: 0 };
      const rng = createAgentRng(randomBytes(4).readUInt32BE(0));
      let action;
      try {
        const decision = await this.agentFor(room, aiId).decide(obs, { rng });
        action = decision.action;
      } catch (err) {
        log.warn('ai_agent_error', { roomId: room.id, aiId, error: String(err).slice(0, 120) });
      }
      if (!action) {
        const candidates = enumerateLegalActions(view, aiId);
        if (candidates.length === 0) return;
        action = rng.pick(candidates);
      }
      try {
        room.handleGameAction(aiId, action);
      } catch (err) {
        if (!(err instanceof RoomError)) throw err;
        // Illegal proposal (LLM drift): submit any engine-validated candidate.
        const legal = enumerateLegalActions(view, aiId).filter((a) => room.engine?.validateAction(a));
        if (legal.length === 0) return;
        room.handleGameAction(aiId, rng.pick(legal));
      }
      this.broadcaster.afterChange(room);
      log.debug('ai_action', { roomId: room.id, aiId, type: action.type });
    } catch (err) {
      log.error('ai_loop_error', { roomId: room.id, error: String(err).slice(0, 160) });
    } finally {
      this.busy.delete(guard);
      // Chain: same player continues (pairone match) or next AI turn.
      this.notify(room);
    }
  }
}
