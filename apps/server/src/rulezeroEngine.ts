/**
 * RuleZero service adapter (Phase-2 Milestone 4).
 *
 * Bridges a Game Night room seat map to an internal `rulezero.service`
 * subprocess speaking `game-service/v1` line-JSON over stdio.
 *
 * Architecture note (§0/§16): this adapter understands NOTHING about game
 * rules. The spec arrives as opaque JSON; views are forwarded untouched;
 * actions are forwarded as integers. All semantics live in the Python
 * service / OpenSpiel.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RZServiceView {
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

function pythonBin(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // <repo>/apps/server/src → repo root is three levels up (dist may differ)
  const candidates = [
    process.env.RULEZERO_PYTHON,
    path.resolve(here, '../../../research/rulezero/.venv/bin/python'),
    '/home/coder/Game_Night/research/rulezero/.venv/bin/python',
  ].filter((x): x is string => Boolean(x));
  const bin = candidates.find((x) => x.length > 0);
  if (!bin) throw new Error('no rulezero python found (set RULEZERO_PYTHON)');
  return bin;
}

function serviceHome(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return (
    process.env.RULEZERO_HOME ??
    path.resolve(here, '../../../research/rulezero')
  );
}

export class RuleZeroEngine {
  readonly gameId = 'rulezero' as const;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, (v: unknown) => void>();
  private seq = 0;
  private seatIndex = new Map<string, number>();
  private playerCount = 2;
  private terminal = false;
  private lastReturns: number[] | null = null;
  private specHash = '';

  /**
   * Strictly-ordered request/response (the service answers one line per
   * request in order). One in-flight request keeps the pairing trivial and
   * is plenty for card-game action rates (§16).
   */
  private lastError: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private askOrdered<T = Record<string, unknown>>(
    msg: Record<string, unknown>,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      if (!this.proc) throw new Error('rulezero service not running');
      const proc = this.proc;
      return await new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('rulezero service timeout')),
          10_000,
        );
        const rl = this.readline!;
        const onLine = (line: string) => {
          clearTimeout(timeout);
          rl.off('line', onLine);
          try {
            const parsed = JSON.parse(line);
            if (parsed.ok === false) {
              reject(new Error(String(parsed.error ?? 'service error')));
            } else {
              resolve(parsed as T);
            }
          } catch (e) {
            reject(e as Error);
          }
        };
        rl.on('line', onLine);
        proc.stdin.write(JSON.stringify(msg) + '\n');
      });
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  private readline: ReturnType<typeof createInterface> | null = null;

  private aiKinds = new Map<string, 'cfr' | 'random'>();

  /** Register which seated players are CPU agents and their strategy. */
  setAiSeats(aiSeats: { playerId: string; kind: 'cfr' | 'random' }[]): void {
    this.aiKinds = new Map(aiSeats.map((a) => [a.playerId, a.kind]));
  }

  async currentPlayerId(): Promise<string | null> {
    if (!this.readline || this.terminal) return null;
    try {
      const v = await this.askOrdered<{ currentActor: number | null }>({
        op: 'view', player: 0,
      });
      if (v.currentActor === null) return null;
      for (const [pid, seat] of this.seatIndex) {
        if (seat === v.currentActor) return pid;
      }
    } catch {
      /* service restarting */
    }
    return null;
  }

  /**
   * Ask the RuleZero service to choose an action for this seat (§9).
   * Returns the chosen dense action id, or null when nothing to do.
   */
  async chooseAiAction(playerId: string): Promise<number | null> {
    const kind = this.aiKinds.get(playerId) ?? 'random';
    const r = await this.askOrdered<{
      ok: boolean; action?: number; chanceApplied?: boolean;
    }>({ op: 'aiChoose', agent: kind, iterations: 300 });
    if (!r.ok) return null;
    return r.chanceApplied ? -1 : (r.action ?? null);
  }

  async createGame(
    seats: { id: string; name: string; seat: number }[],
    _opts?: {
      seed?: number; spec?: object;
      aiSeats?: { playerId: string; kind: 'cfr' | 'random' }[];
    },
  ): Promise<void> {
    this.playerCount = seats.length;
    this.seatIndex = new Map(seats.map((s) => [s.id, s.seat]));
    this.setAiSeats(_opts?.aiSeats ?? []);
    this.terminal = false;
    this.lastReturns = null;

    this.proc = spawn(pythonBin(), ['-m', 'rulezero.service'], {
      cwd: serviceHome(),
      env: { ...process.env, PYTHONPATH: serviceHome() },
    }) as ChildProcessWithoutNullStreams;
    this.readline = createInterface(this.proc.stdout);
    this.proc.stderr.on('data', (d: Buffer) => {
      console.error('[rulezero-service]', d.toString().trim());
    });
    this.proc.on('exit', (code) => {
      console.error(`[rulezero-service] exited code=${code}`);
      this.readline = null;
      this.proc = null;
    });

    const res = await this.askOrdered<{ players: number; specHash: string }>({
      op: 'create',
      spec: _opts?.spec ?? KUHNISH_SPEC,
      seed: _opts?.seed ?? 1,
    });
    this.specHash = res.specHash;
  }

  async getPlayerStateAsync(viewerId: string): Promise<RuleZeroPlayerView> {
    const idx = this.seatIndex.get(viewerId) ?? 0;
    const res = await this.askOrdered<{ view: RZServiceView }>({
      op: 'view',
      player: idx,
    });
    if (res.view.isTerminal && !this.terminal) {
      this.terminal = true;
      const r = await this.askOrdered<{ returns: number[] | null }>({
        op: 'returns',
      });
      this.lastReturns = r.returns ?? null;
    }
    if (!res.view.isTerminal) this.terminal = false;
    return { gameId: 'rulezero' as const, rz: res.view };
  }

  async handleActionAsync(
    playerId: string,
    actionIndex: number,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.seatIndex.has(playerId)) {
      return { ok: false, error: 'not seated' };
    }
    if (this.terminal) return { ok: false, error: 'game finished' };
    try {
      const r = await this.askOrdered<{ isTerminal: boolean }>({
        op: 'apply',
        action: actionIndex,
      });
      this.terminal = r.isTerminal;
      if (r.isTerminal) {
        const rr = await this.askOrdered<{ returns: number[] | null }>({
          op: 'returns',
        });
        this.lastReturns = rr.returns ?? null;
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * Minimal opaque state for debug/persistence surfaces. The authoritative
   * live state lives in the service; reconnect uses snapshot/restore (§16).
   */
  getState(): {
    phase: string;
    specHash: string;
    players: Array<{ id: string; seat: number }>;
    currentTurn: number;
  } {
    return {
      phase: this.terminal ? 'RULEZERO_TERMINAL' : 'RULEZERO_LIVE',
      specHash: this.specHash,
      players: [...this.seatIndex].map(([id, seat]) => ({ id, seat })),
      currentTurn: 0,
    };
  }

  validateAction(): { ok: boolean } {
    // Authority is enforced by the service on apply; nothing client-side
    // to validate beyond seating (checked in handleActionAsync).
    return { ok: true };
  }

  /** Sync envelope: queues an async apply; failures are logged, not thrown
   * (the room broadcasts post-change state either way). */
  handleAction(action: {
    playerId?: string;
    actionIndex?: number;
  }): { ok: boolean; error?: string } {
    const pid = action.playerId ?? '';
    const idx = action.actionIndex;
    if (typeof idx !== 'number') return { ok: false, error: 'actionIndex required' };
    void this.handleActionAsync(pid, idx).then((r) => {
      if (!r.ok) console.error(`[rulezero] apply rejected: ${r.error}`);
    });
    return { ok: true };
  }

  isGameFinished(): boolean {
    return this.terminal;
  }

  calculateScore(): Record<string, number> {
    const out: Record<string, number> = {};
    if (!this.lastReturns) return out;
    for (const [seatId, idx] of this.seatIndex) {
      out[seatId] = Math.round(this.lastReturns[idx] ?? 0);
    }
    return out;
  }

  dispose(): void {
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = null;
    this.readline = null;
  }

  get specHashValue(): string {
    return this.specHash;
  }
}
