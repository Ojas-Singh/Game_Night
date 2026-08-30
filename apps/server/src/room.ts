/**
 * A Room: lobby + chat + one running game instance.
 *
 * Platform-level concerns only — game rules live behind the engine. The room
 * broadcasts per-player FILTERED views; it never forwards raw engine state.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { GameAction } from '@game-night/shared';
import { CaboEngine, type CaboPlayerView, type CaboState } from '@game-night/engine-cabo';
import { RuleZeroEngine, type RuleZeroPlayerView } from './rulezeroEngine.js';
import { takeRulezeroSpec } from './gameLab.js';
import { PairOneEngine, type PairOnePlayerView } from '@game-night/engine-pairone';
import { SeepEngine, type SeepPlayerView, type SeepState } from '@game-night/engine-seep';
import type { ChatMessage, LobbyPlayer, RoomLobbyState } from './protocol.js';
import { isValidAvatar, randomAvatar, type Avatar } from './protocol.js';
import { log } from './log.js';

/** Any engine on the platform. Rooms talk to this union via the shared surface
 *  (createGame/getState/getPlayerState/handleAction/calculateScore/...). */
export type AnyGameEngine = CaboEngine | PairOneEngine | SeepEngine | RuleZeroEngine;
export type AnyGameView = CaboPlayerView | PairOnePlayerView | SeepPlayerView | RuleZeroPlayerView;

/** Available games on the platform. Adding one here lights it up everywhere. */
const GAME_REGISTRY = {
  cabo: {
    id: 'cabo',
    label: 'Cabo',
    minPlayers: 2,
    maxPlayers: 6,
    create: () => new CaboEngine(),
  },
  pairone: {
    id: 'pairone',
    label: 'Pair One',
    minPlayers: 2,
    maxPlayers: 6,
    create: () => new PairOneEngine(),
  },
  seep: {
    id: 'seep',
    label: 'Seep',
    minPlayers: 4,
    maxPlayers: 4,
    create: () => new SeepEngine(),
  },
  // GameSpec/OpenSpiel game served by the internal rulezero service (§16).
  // TS knows nothing about the rules — it forwards an opaque spec and
  // renders whatever structured views come back.
  rulezero: {
    id: 'rulezero',
    label: 'RuleZero Duel',
    minPlayers: 2,
    maxPlayers: 2,
    create: () => new RuleZeroEngine(),
  },
} as const;

export type GameId = keyof typeof GAME_REGISTRY;

export interface RoomPlayer {
  id: string;
  name: string;
  /** Customizable avatar (skribbl-style), shown around the table. */
  avatar: Avatar;
  /** 'ai' seats are driven by the server's agent loop, never by sockets. */
  kind: 'human' | 'ai';
  /** Strategy persona for AI seats (agent-llm PERSONAS id). */
  persona?: string;
  /** Secret token stored in the player's browser; never broadcast. */
  token: string;
  ready: boolean;
  connected: boolean;
  /** Socket ids currently attached (usually exactly one). */
  sockets: Set<string>;
  disconnectedAt: number | null;
  joinedAt: number;
}

export interface RoomOptions {
  roomId?: string;
  reconnectGraceMs?: number;
  debug?: RoomDebug;
}

export interface RoomDebug {
  seed?: number;
  forcedDeckIds?: string[];
}

const ADJECTIVES = ['Cozy', 'Lucky', 'Swift', 'Bright', 'Calm', 'Bold', 'Clever', 'Warm'];
const ANIMALS = ['Otter', 'Fox', 'Heron', 'Elk', 'Lynx', 'Moth', 'Ibex', 'Crow'];

export function randomName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const n = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]!;
  return `${a} ${n}`;
}

export class Room {
  /** One-shot gallery spec token consumed by dealNewGame (§38 flow). */
  rulezeroSpecToken?: string;
  /** Set by the socket layer: fired when an async engine session is ready
   * so views + agent pumps re-run (service spawn is not synchronous). */
  notifyHook?: () => void;
  readonly id: string;
  createdAt = Date.now();
  players = new Map<string, RoomPlayer>();
  hostId: string | null = null;
  gameId: GameId = 'cabo';
  chat: ChatMessage[] = [];
  engine: AnyGameEngine | null = null;
  /** Cumulative match scoreboard across rounds. */
  scoreboard: Record<string, number> = {};
  /** Test Mode: reveal every card's value to all players so anyone can watch
   *  the full flow. Purely a debugging/test aid — off by default. */
  testMode = false;
  debug: RoomDebug;
  private reconnectGraceMs: number;
  private chatSeq = 0;
  closed = false;

  constructor(opts: RoomOptions = {}) {
    this.id = opts.roomId ?? randomRoomCode();
    this.reconnectGraceMs = opts.reconnectGraceMs ?? 120_000;
    this.debug = opts.debug ?? {};
  }

  /** Rebuild a room from a persisted snapshot (app restart recovery). */
  static fromSnapshot(snap: import('./persistence.js').RoomSnapshot): Room {
    const room = new Room({ roomId: snap.id });
    room.createdAt = snap.createdAt;
    room.hostId = snap.hostId;
    room.gameId = (snap.gameId in GAME_REGISTRY ? snap.gameId : 'cabo') as GameId;
    room.chat = snap.chat;
    room.scoreboard = snap.scoreboard;
    room.testMode = snap.testMode ?? false;
    room.debug = snap.debug ?? {};
    for (const sp of snap.players) {
      room.players.set(sp.id, {
        id: sp.id,
        name: sp.name,
        avatar: isValidAvatar(sp.avatar) ? sp.avatar : randomAvatar(),
        kind: sp.kind === 'ai' ? 'ai' : 'human',
        persona: sp.persona,
        token: sp.token,
        ready: sp.kind === 'ai' ? true : sp.ready,
        // AI seats are always "connected" — the agent loop speaks for them.
        connected: sp.kind === 'ai' ? true : false,
        sockets: new Set(),
        disconnectedAt: sp.disconnectedAt,
        joinedAt: sp.joinedAt,
      });
    }
    if (snap.engineState) {
      if (snap.gameId === 'pairone') {
        const engine = new PairOneEngine();
        engine.restoreState(snap.engineState as import('@game-night/engine-pairone').PairOneState);
        room.engine = engine;
      } else if (snap.gameId === 'seep') {
        const engine = new SeepEngine();
        engine.restoreState(snap.engineState as SeepState);
        room.engine = engine;
      } else {
        const engine = new CaboEngine();
        engine.restoreState(snap.engineState as CaboState);
        room.engine = engine;
      }
    }
    return room;
  }

  // -------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------

  addPlayer(name?: string, existingToken?: string): { player: RoomPlayer; reconnected: boolean } {
    // Reconnect: token maps back to an existing participant.
    if (existingToken) {
      for (const p of this.players.values()) {
        if (p.token === existingToken) {
          const wasDisconnected = !p.connected;
          p.connected = true;
          p.disconnectedAt = null;
          if (wasDisconnected && p.kind === 'ai' && this.engine) {
            p.kind = 'human'; // hand the seat back to the returning player
          }
          // Only announce a real return, not a duplicate/attach on an
          // already-connected player (multiple tabs, reconnect spam).
          if (wasDisconnected) this.system(`${p.name} reconnected`);
          return { player: p, reconnected: true };
        }
      }
    }
    if (this.engine) {
      // Mid-game join without a valid token → reject (bots/spectators later).
      throw new RoomError('game already in progress');
    }
    if (this.players.size >= GAME_REGISTRY[this.gameId].maxPlayers) {
      throw new RoomError('room is full');
    }
    const player: RoomPlayer = {
      id: randomUUID(),
      name: sanitizeName(name) ?? randomName(),
      avatar: randomAvatar(),
      kind: 'human',
      token: randomBytes(24).toString('base64url'),
      ready: false,
      connected: true,
      sockets: new Set(),
      disconnectedAt: null,
      joinedAt: Date.now(),
    };
    this.players.set(player.id, player);
    if (!this.hostId) {
      this.hostId = player.id;
      this.system(`${player.name} created the room`);
    } else {
      this.system(`${player.name} joined`);
    }
    return { player, reconnected: false };
  }

  /** Host seats an AI player (lobby only). The agent loop drives its turns. */
  addAiPlayer(hostId: string, persona?: string): RoomPlayer {
    if (hostId !== this.hostId) throw new RoomError('only the host can add AI players');
    if (this.engine) throw new RoomError('game already in progress');
    if (this.players.size >= GAME_REGISTRY[this.gameId].maxPlayers) {
      throw new RoomError('room is full');
    }
    const clean = sanitizeAiPersona(persona);
    const names = ['Ada', 'Byron', 'Cortez', 'Dijkstra', 'Erdos', 'Fibonacci'];
    const used = new Set([...this.players.values()].map((p) => p.name));
    const base = `AI ${clean.label}`;
    let name = base;
    for (const n of names) {
      if (!used.has(`${base} ${n}`)) {
        name = used.has(base) ? `${base} ${n}` : base;
        break;
      }
    }
    const player: RoomPlayer = {
      id: randomUUID(),
      name,
      avatar: randomAvatar(),
      kind: 'ai',
      persona: clean.id,
      token: randomBytes(24).toString('base64url'),
      ready: true,
      connected: true,
      sockets: new Set(),
      disconnectedAt: null,
      joinedAt: Date.now(),
    };
    this.players.set(player.id, player);
    this.system(`${player.name} (AI) joined the table`);
    return player;
  }

  removePlayer(playerId: string, reason: 'left' | 'kicked by the host' = 'left'): void {
    const p = this.players.get(playerId);
    if (!p) return;
    this.players.delete(playerId);
    this.system(`${p.name} ${reason}`);
    if (this.hostId === playerId) {
      // Host reassignment: longest-standing remaining member.
      const next = [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      this.hostId = next?.id ?? null;
      if (next) this.system(`${next.name} is now the host`);
    }
    delete this.scoreboard[playerId];
  }

  markDisconnected(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = false;
    p.disconnectedAt = Date.now();
    this.system(`${p.name} disconnected`);
    // Mid-game auto-skip: a departed seat is played by the bot pump so the
    // table never stalls waiting for someone who is not there.
    if (this.engine) {
      p.kind = 'ai';
      p.persona = p.persona ?? 'balanced';
      this.system(`${p.name}'s seat is on autopilot until they return`);
    }
  }

  /** Host aborts the running game and returns everyone to the lobby. */
  endGame(hostId: string): void {
    if (hostId !== this.hostId) throw new RoomError('only the host can end the game');
    if (!this.engine) throw new RoomError('no game is running');
    this.engine = null;
    this.system('Host ended the game — back to the lobby');
  }

  /** Host kicks an ACTIVE-Game player mid-match: their seat converts to the
   *  bot so play continues (full removal stays lobby-only). */
  kickInGame(hostId: string, targetId: string): void {
    if (hostId !== this.hostId) throw new RoomError('only the host can kick players');
    if (targetId === this.hostId) throw new RoomError('the host cannot be kicked');
    if (!this.engine) throw new RoomError('players can only be kicked in the lobby');
    const p = this.players.get(targetId);
    if (!p) throw new RoomError('not in room');
    if (p.kind === 'ai') throw new RoomError('already an AI seat');
    p.kind = 'ai';
    p.persona = p.persona ?? 'balanced';
    this.system(`${p.name} was handed to the autopilot by the host`);
  }

  /** Host removes a player from the room. Lobby only — never mid-game (the
   *  engine state is built from the seated players and cannot lose one). */
  kickPlayer(hostId: string, targetId: string): void {
    if (hostId !== this.hostId) throw new RoomError('only the host can kick players');
    if (targetId === this.hostId) throw new RoomError('the host cannot be kicked');
    if (this.engine) throw new RoomError('players can only be kicked in the lobby');
    if (!this.players.has(targetId)) throw new RoomError('not in room');
    this.removePlayer(targetId, 'kicked by the host');
  }

  /** True when the reconnect grace period for a player has elapsed. */
  isExpiredPlayer(p: RoomPlayer, now = Date.now()): boolean {
    return !p.connected && p.disconnectedAt !== null && now - p.disconnectedAt > this.reconnectGraceMs;
  }

  isIdle(now = Date.now()): boolean {
    if (this.players.size === 0) return true;
    return [...this.players.values()].every((p) => this.isExpiredPlayer(p, now));
  }

  attachSocket(playerId: string, socketId: string): void {
    this.players.get(playerId)?.sockets.add(socketId);
  }

  detachSocket(playerId: string, socketId: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    p.sockets.delete(socketId);
    // Note: presence marking is NOT done here — the caller decides (e.g.
    // after a debounce window) so transient blips don't bounce seats.
  }

  // -------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------

  /** A player customizes their own avatar (validated server-side). */
  setAvatar(playerId: string, avatar: Avatar): void {
    const p = this.players.get(playerId);
    if (!p) throw new RoomError('not in room');
    if (!isValidAvatar(avatar)) throw new RoomError('invalid avatar');
    p.avatar = avatar;
  }

  setName(playerId: string, name: string): void {
    const p = this.players.get(playerId);
    if (!p) throw new RoomError('not in room');
    const clean = sanitizeName(name);
    if (!clean) throw new RoomError('invalid name');
    if (clean !== p.name) {
      this.system(`${p.name} changed their name to ${clean}`);
      p.name = clean;
    }
  }

  setReady(playerId: string, ready: boolean): void {
    const p = this.players.get(playerId);
    if (!p) throw new RoomError('not in room');
    p.ready = ready;
  }

  selectGame(playerId: string, gameId: string): void {
    if (playerId !== this.hostId) throw new RoomError('only the host can select the game');
    if (!(gameId in GAME_REGISTRY)) throw new RoomError('unknown game');
    this.gameId = gameId as GameId;
    this.system(`Host selected ${GAME_REGISTRY[gameId as GameId].label}`);
  }

  /** Create and deal the selected game for the currently seated players. */
  private dealNewGame(): AnyGameEngine {
    const reg = GAME_REGISTRY[this.gameId];
    const seated = [...this.players.values()];
    if (seated.length < reg.minPlayers) {
      throw new RoomError(`needs at least ${reg.minPlayers} players`);
    }
    const seats = seated.map((p, i) => ({ id: p.id, name: p.name, seat: i }));
    if (reg.id === 'rulezero') {
      const rz = reg.create() as RuleZeroEngine;
      const spec = takeRulezeroSpec(this.rulezeroSpecToken);
      this.rulezeroSpecToken = undefined;
      // Persona → solver kind: strong/balanced personas get CFR.
      const SOLVER_PERSONAS = new Set(['balanced', 'strong', 'solver']);
      const aiSeats = seated
        .filter((p) => p.kind === 'ai')
        .map((p) => ({
          playerId: p.id,
          kind: (SOLVER_PERSONAS.has(p.persona ?? '')
            ? 'cfr'
            : 'random') as 'cfr' | 'random',
        }));
      void rz
        .createGame(seats, { seed: this.debug.seed, spec, aiSeats })
        .then(() => this.notifyHook?.())
        .catch((err) => {
          console.error('[rulezero] create failed:', err);
          this.notifyHook?.();
        });
      return rz; // views arrive once the service session is live
    }
    let engine: AnyGameEngine;
    if (reg.id === 'cabo') {
      const cabo = new CaboEngine();
      cabo.createGame(seats, {
        seed: this.debug.seed,
      });
      // Everyone is shown their bottom-row cards automatically at the start
      // (bottom row of the 2×2 layout = indexes 1 and 3). The values flash
      // briefly on each client, then flip back down — it's a memory game.
      const rules = cabo.getRules();
      const peekIndexes = Array.from(
        { length: rules.initialPeekCards },
        (_, i) => Math.min(2 * i + 1, rules.startingCards - 1),
      ).filter((v, i, arr) => arr.indexOf(v) === i);
      for (const p of seated) {
        cabo.handleAction({
          type: 'PEEK_STARTING',
          playerId: p.id,
          cardIndexes: peekIndexes,
        } as unknown as GameAction);
      }
      engine = cabo;
    } else if (reg.id === 'seep') {
      const seep = new SeepEngine();
      seep.createGame(seats, { seed: this.debug.seed });
      engine = seep;
    } else {
      const pairOne = new PairOneEngine();
      pairOne.createGame(seats, { seed: this.debug.seed });
      engine = pairOne;
    }
    return engine;
  }

  startGame(playerId: string): void {
    if (playerId !== this.hostId) throw new RoomError('only the host can start the game');
    if (this.engine) throw new RoomError('game already running');
    this.engine = this.dealNewGame();
    for (const p of this.players.values()) p.ready = false;
    const opener =
      this.gameId === 'pairone'
        ? 'Game started — Pair One! Flip two cards; match the numbers to collect the pair.'
        : this.gameId === 'seep'
          ? 'Game started — Seep! You & your partner (across the table) capture cards, build houses, and sweep the table for a bonus!'
          : 'Game started — Cabo! You briefly saw your bottom two cards — remember them!';
    this.system(opener);
    log.info('game_start', { roomId: this.id, gameId: this.gameId, players: this.players.size });
  }

  /** Host toggles Test Mode: reveal every card to everyone (debug aid). */
  setTestMode(playerId: string, enabled: boolean): void {
    if (playerId !== this.hostId) throw new RoomError('only the host can toggle Test Mode');
    this.testMode = enabled;
    this.system(enabled ? 'TEST MODE ON — all cards revealed' : 'TEST MODE OFF');
  }

  /** Host restarts the round at ANY time: fresh deal, scoreboard preserved. */
  restartGame(playerId: string): void {
    if (playerId !== this.hostId) throw new RoomError('only the host can restart the game');
    const seated = [...this.players.values()];
    if (seated.length < GAME_REGISTRY[this.gameId].minPlayers) {
      throw new RoomError(`needs at least ${GAME_REGISTRY[this.gameId].minPlayers} players`);
    }
    this.engine = null;
    this.startGame(playerId);
    this.system('Host restarted the game — fresh deal!');
  }

  returnToLobby(playerId: string): void {
    if (playerId !== this.hostId) throw new RoomError('only the host can return to the lobby');
    this.engine = null;
    this.system('Returned to the lobby');
  }

  /** Host starts a fresh round in the same room; match scoreboard persists. */
  playAgain(playerId: string): void {
    if (playerId !== this.hostId) throw new RoomError('only the host can start the next round');
    if (this.engine && !this.engine.isGameFinished()) {
      throw new RoomError('current round is still in progress');
    }
    const label = GAME_REGISTRY[this.gameId].label;
    this.engine = null;
    this.startGame(playerId);
    this.system(`Next round — ${label}!`);
  }

  /** Cumulative match scoreboard across rounds (public info). */
  getScoreboard(): Record<string, number> {
    return { ...this.scoreboard };
  }

  // -------------------------------------------------------------------
  // Gameplay
  // -------------------------------------------------------------------

  handleGameAction(playerId: string, action: GameAction): void {
    if (!this.engine) throw new RoomError('no game running');
    // The room stamps authority: the acting player comes from the socket,
    // never from client-supplied payloads.
    const result = this.engine.handleAction({ ...action, playerId });
    if (!result.ok) {
      log.warn('illegal_action', { roomId: this.id, playerId, type: action.type, error: result.error });
      throw new RoomError(result.error ?? 'illegal action');
    }
    if (this.engine.isGameFinished()) {
      const scores = this.engine.calculateScore();
      for (const [pid, pts] of Object.entries(scores)) {
        this.scoreboard[pid] = (this.scoreboard[pid] ?? 0) + pts;
      }
    }
  }

  // -------------------------------------------------------------------
  // Views (always filtered)
  // -------------------------------------------------------------------

  lobbyState(): RoomLobbyState {
    return {
      roomId: this.id,
      gameId: this.gameId,
      players: [...this.players.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p): LobbyPlayer => ({
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          isHost: p.id === this.hostId,
          ready: p.ready,
          connected: p.connected,
          kind: p.kind,
          aiPersona: p.kind === 'ai' ? (p.persona ?? 'balanced') : undefined,
          isYou: false, // client marks its own player
        })),
      inGame: !!this.engine,
      hostId: this.hostId ?? '',
      scoreboard: this.getScoreboard(),
      testMode: this.testMode,
    };
  }

  gameView(playerId: string): AnyGameView | null {
    if (!this.engine) return null;
    if (!this.players.has(playerId)) return null; // spectators: public state only (later)
    if (this.engine instanceof RuleZeroEngine) {
      // Service-backed: views are async; the socket layer uses
      // gameViewAsync for these rooms.
      return null; // sync callers get null; see gameViewAsync
    }
    const opts = this.testMode ? { revealAll: true } : undefined;
    return this.engine.getPlayerState(playerId, opts);
  }

  /** Async variant for service-backed engines (rulezero). */
  async gameViewAsync(playerId: string): Promise<AnyGameView | null> {
    if (!this.engine) return null;
    if (!this.players.has(playerId)) return null;
    if (this.engine instanceof RuleZeroEngine) {
      try {
        return await this.engine.getPlayerStateAsync(playerId);
      } catch (err) {
        console.error('[rulezero] view failed:', err);
        return null;
      }
    }
    return this.gameView(playerId);
  }

  // -------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------

  playerChat(playerId: string, text: string): ChatMessage | null {
    const p = this.players.get(playerId);
    if (!p) throw new RoomError('not in room');
    const clean = text.trim().slice(0, 500);
    if (!clean) return null;
    const msg: ChatMessage = {
      id: `${this.id}-${++this.chatSeq}`,
      roomId: this.id,
      playerId: p.id,
      playerName: p.name,
      text: clean,
      timestamp: new Date().toISOString(),
    };
    this.chat.push(msg);
    if (this.chat.length > 200) this.chat.splice(0, this.chat.length - 200);
    return msg;
  }

  system(text: string): void {
    const msg: ChatMessage = {
      id: `${this.id}-${++this.chatSeq}`,
      roomId: this.id,
      playerId: null,
      playerName: null,
      text,
      timestamp: new Date().toISOString(),
    };
    this.chat.push(msg);
  }
}

export class RoomError extends Error {}

export function randomRoomCode(): string {
  // Unambiguous alphabet (no 0/O, 1/I) — 6 chars, e.g. "ABCD12"-style.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += alphabet[bytes[i]! % alphabet.length];
  }
  return code;
}

function sanitizeName(name: string | undefined): string | null {
  if (!name) return null;
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 24);
  return clean.length >= 1 ? clean : null;
}

const AI_PERSONA_IDS = ['balanced', 'baiter', 'conservative', 'aggressor', 'scholar'];
const AI_PERSONA_LABELS: Record<string, string> = {
  balanced: 'Balanced',
  baiter: 'Baiter',
  conservative: 'Conservative',
  aggressor: 'Aggressor',
  scholar: 'Scholar',
};

/** Validate a requested AI persona; unknown/absent → balanced. */
export function sanitizeAiPersona(persona?: string): { id: string; label: string } {
  const id = persona && AI_PERSONA_IDS.includes(persona) ? persona : 'balanced';
  return { id, label: AI_PERSONA_LABELS[id] ?? 'Balanced' };
}
