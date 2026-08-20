/**
 * A Room: lobby + chat + one running game instance.
 *
 * Platform-level concerns only — game rules live behind the engine. The room
 * broadcasts per-player FILTERED views; it never forwards raw engine state.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { GameAction } from '@game-night/shared';
import { CaboEngine, type CaboPlayerView } from '@game-night/engine-cabo';
import type { ChatMessage, LobbyPlayer, RoomLobbyState } from './protocol.js';
import { log } from './log.js';

/** Available games on the platform. Adding one here lights it up everywhere. */
const GAME_REGISTRY = {
  cabo: {
    id: 'cabo',
    label: 'Cabo',
    minPlayers: 2,
    maxPlayers: 6,
    create: () => new CaboEngine(),
  },
} as const;

export type GameId = keyof typeof GAME_REGISTRY;

export interface RoomPlayer {
  id: string;
  name: string;
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
  readonly id: string;
  createdAt = Date.now();
  players = new Map<string, RoomPlayer>();
  hostId: string | null = null;
  gameId: GameId = 'cabo';
  chat: ChatMessage[] = [];
  engine: CaboEngine | null = null;
  /** Cumulative match scoreboard across rounds. */
  scoreboard: Record<string, number> = {};
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
    room.gameId = (snap.gameId in { cabo: 1 } ? snap.gameId : 'cabo') as GameId;
    room.chat = snap.chat;
    room.scoreboard = snap.scoreboard;
    room.debug = snap.debug ?? {};
    for (const sp of snap.players) {
      room.players.set(sp.id, {
        id: sp.id,
        name: sp.name,
        token: sp.token,
        ready: sp.ready,
        connected: false,
        sockets: new Set(),
        disconnectedAt: sp.disconnectedAt,
        joinedAt: sp.joinedAt,
      });
    }
    if (snap.engineState) {
      const engine = new CaboEngine();
      engine.restoreState(snap.engineState);
      room.engine = engine;
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
          p.connected = true;
          p.disconnectedAt = null;
          this.system(`${p.name} reconnected`);
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

  removePlayer(playerId: string, reason: 'left' = 'left'): void {
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
    if (p.sockets.size === 0) this.markDisconnected(playerId);
  }

  // -------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------

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

  startGame(playerId: string): void {
    if (playerId !== this.hostId) throw new RoomError('only the host can start the game');
    if (this.engine) throw new RoomError('game already running');
    const reg = GAME_REGISTRY[this.gameId];
    const seated = [...this.players.values()];
    if (seated.length < reg.minPlayers) {
      throw new RoomError(`needs at least ${reg.minPlayers} players`);
    }
    const engine = reg.create();
    engine.createGame(
      seated.map((p, i) => ({ id: p.id, name: p.name, seat: i })),
      { seed: this.debug.seed },
    );
    this.engine = engine;
    for (const p of seated) p.ready = false;
    this.system('Game started — Cabo!');
    log.info('game_start', { roomId: this.id, gameId: this.gameId, players: seated.length });
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
    this.engine = null;
    this.startGame(playerId);
    this.system('Next round — Cabo!');
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
          isHost: p.id === this.hostId,
          ready: p.ready,
          connected: p.connected,
          isYou: false, // client marks its own player
        })),
      inGame: !!this.engine,
      hostId: this.hostId ?? '',
      scoreboard: this.getScoreboard(),
    };
  }

  gameView(playerId: string): CaboPlayerView | null {
    if (!this.engine) return null;
    if (!this.players.has(playerId)) return null; // spectators: public state only (later)
    return this.engine.getPlayerState(playerId);
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
