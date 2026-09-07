/**
 * RuleZero service adapter (Phase-2 Milestone 4).
 *
 * Bridges a Game Night room seat map to an internal `rulezero.service`
 * subprocess speaking `game-service/v2` line-JSON over stdio.
 *
 * Architecture note (§0/§16): this adapter understands NOTHING about game
 * rules. The spec arrives as opaque JSON; views are forwarded untouched;
 * actions are forwarded as integers. All semantics live in the Python
 * service / OpenSpiel.
 */
import { randomUUID } from 'node:crypto';
import { RuleZeroClient, ServiceError } from './rulezeroClient.js';

export interface RZServiceView {
  revision: number;
  runtimeVersion: number;
  protocol: string;
  specHash: string;
  player: number;
  phase?: string;
  observation: string;
  informationState: string;
  isTerminal: boolean;
  currentActor: number | null;
  candidates: {
    candidateId: string;
    environmentActionId: number;
    label: string;
  }[];
  zones: {
    id: string;
    visibility: 'hidden' | 'owner' | 'public';
    owner: number | null;
    cards?: number[];
    count?: number;
  }[];
  scores?: Record<string, number>;
}

export interface RuleZeroPlayerView {
  review?: {
    nashConv: number | null;
    decisions: {
      step: number;
      player: number;
      chosen?: string | null;
      referenceTop?: [string, number] | null;
      distribution: [string, number][];
    }[];
  };
  gameId: 'rulezero';
  rz: RZServiceView;
}

/** Opaque fixture spec for the first live gate (kuhnish IR). */
const KUHNISH_SPEC = {
  schemaVersion: 1,
  name: 'kuhnish',
  players: { count: 2 },
  entities: { cardRanks: [9, 10, 11], copiesPerRank: 1 },
  zones: [
    { id: 'deck', visibility: 'hidden' },
    { id: 'hand', perPlayer: true, visibility: 'owner' },
  ],
  vars: [
    { id: 'pot', init: 0 },
    { id: 'raised', init: 0 },
    { id: 'score0', init: -1 },
    { id: 'score1', init: -1 },
  ],
  phases: [
    { id: 'deal', kind: 'chance',
      chance: { from: 'deck', to: 'hand@p', count: 1 } },
    { id: 'act0', kind: 'decision',
      decision: { actor: 0, actions: [
        { id: 'check', goto: 'act1' },
        { id: 'bet', effects: [
          { op: 'incr', var: 'pot', by: 1 },
          { op: 'dec', var: 'score0', by: 1 },
          { op: 'set', var: 'raised', value: 1 }],
          goto: 'act1' }] } },
    { id: 'act1', kind: 'decision',
      decision: { actor: 1, actions: [
        { id: 'fold', goto: 'fold_award' },
        { id: 'call', requires: { var: 'raised', eq: 1 },
          effects: [{ op: 'incr', var: 'pot', by: 1 },
                    { op: 'dec', var: 'score1', by: 1 }],
          goto: 'showdown' },
        { id: 'checkback', requires: { var: 'raised', eq: 0 },
          goto: 'showdown' }] } },
    { id: 'showdown', kind: 'decision',
      decision: { actor: 0, actions: [
        { id: 'reveal', effects: [
          { op: 'reveal', zone: 'hand@p' },
          { op: 'compareGoto',
            a: { sumRank: 'hand@p' }, b: { sumRank: 'hand@other' },
            gt: 'win_revealer', lt: 'win_other', eq: 'tie' }]}]}},
    { id: 'fold_award', kind: 'award',
      award: { to: 'otherOfLast', amountVar: 'pot', goto: 'end' } },
    { id: 'win_revealer', kind: 'award',
      award: { to: 'lastActor', amountVar: 'pot', goto: 'end' } },
    { id: 'win_other', kind: 'award',
      award: { to: 'otherOfLast', amountVar: 'pot', goto: 'end' } },
    { id: 'tie', kind: 'award',
      award: { to: 'splitAll', amountVar: 'pot', goto: 'end' } },
    { id: 'end', kind: 'terminal' },
  ],
} as const;

export interface RuleZeroPersistedState {
  stateVersion: 2;
  gameId: 'rulezero';
  phase: string;
  specHash: string;
  spec: object;
  seats: { id: string; name: string; seat: number }[];
  aiSeats: { playerId: string; kind: string }[];
  snapshot: Record<string, any>;
}

export class RuleZeroEngine {
  readonly gameId = 'rulezero' as const;
  private client = new RuleZeroClient();
  private seats: RuleZeroPersistedState['seats'] = [];
  private aiSeats: RuleZeroPersistedState['aiSeats'] = [];
  private spec: object = KUHNISH_SPEC;
  private snapshot: Record<string, any> = {};
  private views = new Map<number, RZServiceView>();
  private terminal = false;
  private returns: number[] | null = null;
  private ready: Promise<void> = Promise.resolve();
  private queue: Promise<unknown> = Promise.resolve();

  private async ask<T>(msg: Record<string, unknown>): Promise<T> {
    try { return await this.client.ask<T>(msg); }
    catch (e) {
      if (e instanceof ServiceError || !this.snapshot.specHash) throw e;
      // Recover only from a transport failure, using the last committed snapshot.
      await this.client.ask({ op: 'create', spec: this.spec });
      await this.client.ask({ op: 'restore', state: this.snapshot });
      return this.client.ask<T>(msg);
    }
  }

  private async refresh(): Promise<void> {
    const snap = await this.ask<{ snap: Record<string, any> }>({ op: 'snapshot' });
    const views = new Map<number, RZServiceView>();
    for (let p = -1; p < this.seats.length; p++) {
      const r = await this.ask<{ view: RZServiceView }>({ op: 'view', player: p });
      views.set(p, r.view);
    }
    const r = await this.ask<{ returns: number[] | null }>({ op: 'returns' });
    this.snapshot = snap.snap;
    this.views = views;
    this.terminal = views.get(0)?.isTerminal ?? false;
    this.returns = r.returns;
  }

  setAiSeats(seats: RuleZeroPersistedState['aiSeats']): void { this.aiSeats = seats; }

  createGame(seats: RuleZeroPersistedState['seats'], opts?: { seed?: number; spec?: object; aiSeats?: RuleZeroPersistedState['aiSeats'] }): Promise<void> {
    this.seats = seats;
    this.spec = opts?.spec ?? KUHNISH_SPEC;
    this.aiSeats = opts?.aiSeats ?? [];
    this.ready = (async () => {
      const r = await this.client.ask<{ players: number }>({ op: 'create', spec: this.spec, seed: opts?.seed ?? 1 });
      if (r.players !== seats.length) throw new Error(`game requires exactly ${r.players} seats`);
      await this.refresh();
    })();
    return this.ready;
  }

  restoreState(state: RuleZeroPersistedState): Promise<void> {
    this.spec = state.spec;
    this.seats = state.seats;
    this.aiSeats = state.aiSeats;
    this.ready = (async () => {
      await this.client.ask({ op: 'create', spec: this.spec });
      await this.client.ask({ op: 'restore', state: state.snapshot });
      await this.refresh();
    })();
    return this.ready;
  }

  whenReady(): Promise<void> { return this.ready; }

  async currentPlayerId(): Promise<string | null> {
    await this.ready;
    const actor = this.views.get(0)?.currentActor;
    return this.seats.find(s => s.seat === actor)?.id ?? null;
  }

  async chooseAiAction(playerId: string): Promise<number | null> {
    await this.ready;
    if (await this.currentPlayerId() !== playerId) return null;
    const kind = this.aiSeats.find(a => a.playerId === playerId)?.kind ?? 'random';
    const r = await this.ask<{ action?: number }>({ op: 'aiChoose', agent: kind, iterations: 100 });
    return r.action ?? null;
  }

  async getPlayerStateAsync(viewerId: string): Promise<RuleZeroPlayerView> {
    await this.ready;
    const p = this.seats.find(s => s.id === viewerId)?.seat ?? -1;
    const rz = this.views.get(p);
    if (!rz) throw new Error('view unavailable');
    return { gameId: 'rulezero', rz };
  }

  handleActionAsync(playerId: string, actionIndex: number, expectedRevision?: number, commandId: string = randomUUID()): Promise<{ ok: boolean; error?: string }> {
    const run = async () => {
      await this.ready;
      const seat = this.seats.find(s => s.id === playerId);
      if (!seat) return { ok: false, error: 'not seated' };
      try {
        await this.ask({ op: 'apply', player: seat.seat, action: actionIndex,
          expectedRevision: expectedRevision ?? this.snapshot.revision, commandId });
        await this.refresh();
        return { ok: true };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  getState(): RuleZeroPersistedState {
    return { stateVersion: 2, gameId: 'rulezero', phase: this.terminal ? 'RULEZERO_TERMINAL' : 'RULEZERO_LIVE',
      specHash: this.snapshot.specHash ?? '', spec: this.spec, seats: this.seats,
      aiSeats: this.aiSeats, snapshot: this.snapshot };
  }
  validateAction(): { ok: boolean } { return { ok: false }; }
  handleAction(_action: unknown): { ok: boolean; error?: string } {
    return { ok: false, error: 'service actions require the awaited room command boundary' };
  }
  isGameFinished(): boolean { return this.terminal; }
  calculateScore(): Record<string, number> {
    return Object.fromEntries(this.seats.map(s => [s.id, this.returns?.[s.seat] ?? 0]));
  }
  dispose(): void { this.client.dispose(); }
  get specHashValue(): string { return this.snapshot.specHash ?? ''; }
}
