/**
 * EngineWorld — the SearchWorld port over a REAL engine instance.
 *
 * Clones deep-copy the engine's JSON state into a fresh engine (restoreState),
 * so Monte-Carlo rollouts never touch the live game. This is also exactly how
 * the server can later drive search for live AI seats.
 */

import type { GameAction } from '@game-night/shared';
import type { GameId, AnyGameAction } from '@game-night/agent-core';
import type { SearchWorld } from '@game-night/agent-bots';
import { CaboEngine, buildPlayerView as caboView } from '@game-night/engine-cabo';
import type { CaboState } from '@game-night/engine-cabo';
import { PairOneEngine, buildPlayerView as pairOneView } from '@game-night/engine-pairone';
import type { PairOneState } from '@game-night/engine-pairone';
import type { AnyGameView } from '@game-night/agent-core';

type AnyEngine = CaboEngine | PairOneEngine;

export class EngineWorld implements SearchWorld {
  private constructor(
    readonly gameId: GameId,
    private readonly engine: AnyEngine,
    /** Clonable RNG state — research rollouts must be seed-reproducible. */
    private rngState: number,
  ) {}

  static create(gameId: GameId, players: Array<{ id: string; name: string; seat: number }>, seed: number): EngineWorld {
    // Mix the seed so worlds never start from a degenerate rng state.
    const rngSeed = (seed ^ 0x9e3779b9) >>> 0;
    if (gameId === 'cabo') {
      const e = new CaboEngine();
      e.createGame(players, { seed });
      return new EngineWorld(gameId, e, rngSeed);
    }
    const e = new PairOneEngine();
    e.createGame(players, { seed });
    return new EngineWorld(gameId, e, rngSeed);
  }

  /**
   * Deterministic mulberry32 step; state lives ON the world so clones carry
   * their own stream and identical search trees reproduce bit-for-bit.
   */
  private nextRandom(): number {
    let t = (this.rngState = (this.rngState + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  clone(): EngineWorld {
    const copy = structuredClone(this.engine.getState() as unknown) as { events?: unknown[] };
    // Search never reads event history or accumulated knowledge ids, and
    // both dominate deep-copy cost as episodes grow — drop them from clones.
    copy.events = [];
    const k = copy as { knowledge?: Record<string, string[]> };
    if (k.knowledge) {
      for (const pid of Object.keys(k.knowledge)) k.knowledge[pid] = [];
    }
    if (this.gameId === 'cabo') {
      const e = new CaboEngine();
      e.restoreState(copy as unknown as CaboState);
      return new EngineWorld('cabo', e, this.rngState);
    }
    const e = new PairOneEngine();
    e.restoreState(copy as unknown as PairOneState);
    return new EngineWorld('pairone', e, this.rngState);
  }

  apply(action: AnyGameAction): boolean {
    return this.engine.handleAction(action).ok;
  }

  validate(action: AnyGameAction): boolean {
    return this.engine.validateAction(action);
  }

  isTerminal(): boolean {
    return this.engine.getState().phase === 'ROUND_COMPLETE';
  }

  /** Who owes an action right now (initial peeks are per-player debts). */
  selfToAct(): string | null {
    const s = this.engine.getState();
    if (s.phase === 'ROUND_COMPLETE') return null;
    if (s.gameId === 'cabo' && s.phase === 'INITIAL_PEEK') {
      return s.initialPeeksRemaining[0] ?? null;
    }
    return s.players[s.currentTurn]?.id ?? null;
  }

  viewFor(selfId: string): AnyGameView {
    const s = this.engine.getState();
    return s.gameId === 'cabo'
      ? caboView(s as CaboState, selfId)
      : pairOneView(s as PairOneState, selfId);
  }

  /**
   * One cheap random step, straight off engine STATE — no views, no
   * enumeration. Rollouts run hundreds of these; the shortcut is what makes
   * flat MC affordable. Strategy: minimal valid action per phase.
   */
  advanceRandom(): boolean {
    const s = this.engine.getState();
    if (s.phase === 'ROUND_COMPLETE' || s.phase === 'ROUND_REVEAL') return false;
    if (s.gameId === 'cabo') {
      const st = s as CaboState;
      const me = { playerId: st.players[st.currentTurn]!.id };
      switch (st.phase) {
        case 'INITIAL_PEEK': {
          const who = st.initialPeeksRemaining[0];
          if (!who) return false;
          return this.engine.handleAction({ type: 'PEEK_STARTING', playerId: who, cardIndexes: [0, 1] } as GameAction).ok;
        }
        case 'TURN_DRAW':
          return this.engine.handleAction({ type: 'DRAW', ...me } as GameAction).ok;
        case 'DRAW_DECISION': {
          // Keep into slot 0 half the time; discard otherwise (cheap mix).
          const keep = this.nextRandom() < 0.5;
          return this.engine
            .handleAction(
              keep
                ? ({ type: 'KEEP_DRAWN', ...me, handIndex: st.hands[me.playerId]!.findIndex((c) => !!c) } as GameAction)
                : ({ type: 'DISCARD_DRAWN', ...me } as GameAction),
            )
            .ok;
        }
        case 'POWER_PENDING': {
          const p = st.pendingPower!;
          const others = st.players.filter((o) => o.id !== p.playerId);
          const firstReal = (id: string): string | undefined =>
            st.hands[id]?.find((c): c is NonNullable<typeof c> => !!c)?.id;
          let payload: Extract<import('@game-night/engine-cabo').CaboAction, { type: 'POWER_APPLY' }>['payload'] | null = null;
          if (p.power === 'PEEK_OWN') payload = { power: 'PEEK_OWN', cardId: firstReal(p.playerId)! };
          else if (p.power === 'PEEK_OTHER') payload = { power: 'PEEK_OTHER', targetPlayerId: others[0]!.id, cardId: firstReal(others[0]!.id)! };
          else if (p.power === 'BLIND_SWAP') payload = { power: 'BLIND_SWAP', ownCardId: firstReal(p.playerId)!, targetPlayerId: others[0]!.id, targetCardId: firstReal(others[0]!.id)! };
          else {
            const b = others[1] ?? others[0]!;
            payload = { power: 'SWAP_OTHERS', cardIdA: firstReal(others[0]!.id)!, cardIdB: firstReal(b.id)! };
          }
          return payload ? this.engine.handleAction({ type: 'POWER_APPLY', playerId: p.playerId, payload } as GameAction).ok : false;
        }
        case 'TRANSFER_PENDING': {
          const t = st.pendingTransfer!;
          const card = st.hands[t.fromPlayerId]!.find((c): c is NonNullable<typeof c> => !!c);
          if (!card) return false;
          return this.engine.handleAction({ type: 'TRANSFER_CARD', playerId: t.fromPlayerId, cardId: card.id } as GameAction).ok;
        }
        default:
          return this.engine.handleAction({ type: 'END_TURN', ...me } as GameAction).ok;
      }
    }
    // Pair One: flip a random face-down slot.
    const grid = (s as PairOneState).grid;
    const options: string[] = [];
    for (const c of grid) if (c) options.push(c.id);
    if (options.length === 0) return false;
    const cardId = options[Math.floor(this.nextRandom() * options.length)]!;
    return this.engine.handleAction({ type: 'FLIP_CARD', playerId: s.players[s.currentTurn]!.id, cardId } as GameAction).ok;
  }

  outcomeFor(selfId: string): number {
    const s = this.engine.getState();
    const scores = s.scores;
    if (!scores) return 0;
    const ids = Object.keys(scores);
    let best: number;
    if (this.gameId === 'pairone') best = Math.max(...ids.map((id) => scores[id] ?? 0));
    else best = Math.min(...ids.map((id) => scores[id] ?? Infinity));
    const winners = ids.filter((id) => scores[id] === best);
    // Caller tie-break mirrors engine.endRound; close enough for rollouts.
    return winners.includes(selfId) ? 1 / winners.length + (winners.length > 1 ? 0.5 / winners.length : 0) : 0;
  }

  finalScores(): Record<string, number> {
    return this.engine.getState().scores ?? {};
  }

  phase(): string {
    return this.engine.getState().phase;
  }
}
