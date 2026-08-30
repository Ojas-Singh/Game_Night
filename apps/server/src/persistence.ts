/**
 * Room persistence: snapshot rooms to Redis (production) or keep an
 * in-process store (single-node dev / no REDIS_URL) so an app restart does
 * not corrupt or destroy running games.
 *
 * Serialization is versioned; unknown versions are skipped rather than
 * restored corrupted.
 */

import type { Redis } from 'ioredis';
import { log } from './log.js';
import type { Room, RoomPlayer } from './room.js';
import type { ChatMessage } from './protocol.js';
import type { CaboState } from '@game-night/engine-cabo';
import type { PairOneState } from '@game-night/engine-pairone';
import type { SeepState } from '@game-night/engine-seep';

const SNAPSHOT_VERSION = 1;
const KEY_PREFIX = 'game-night:room:';

/** Whichever engine's serialized state the room was running.
 * RuleZero rooms persist an opaque marker (live state lives in the
 * service; reconnect restores via snapshot/restore, §16). */
export interface RuleZeroPersistedState {
  stateVersion: 1;
  gameId: 'rulezero';
  phase: string;
  specHash: string;
}

export type AnyEngineState =
  | CaboState
  | PairOneState
  | SeepState
  | RuleZeroPersistedState;

export interface RoomSnapshot {
  version: typeof SNAPSHOT_VERSION;
  id: string;
  createdAt: number;
  hostId: string | null;
  gameId: string;
  chat: ChatMessage[];
  scoreboard: Record<string, number>;
  testMode: boolean;
  debug: Room['debug'];
  players: Array<Omit<RoomPlayer, 'sockets'> & { socketCount: number }>;
  engineState: AnyEngineState | null;
}

export function serializeRoom(room: Room): RoomSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    id: room.id,
    createdAt: room.createdAt,
    hostId: room.hostId,
    gameId: room.gameId,
    chat: room.chat.slice(-200),
    scoreboard: room.scoreboard,
    testMode: room.testMode,
    debug: room.debug,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      kind: p.kind,
      persona: p.persona,
      token: p.token,
      ready: p.ready,
      // Restored players begin disconnected; they reconnect with their token.
      connected: false,
      sockets: new Set<string>(),
      socketCount: 0,
      disconnectedAt: p.disconnectedAt ?? room.createdAt,
      joinedAt: p.joinedAt,
    })),
    engineState: room.engine
        ? room.engine.gameId === 'rulezero'
          ? {
              stateVersion: 1 as const,
              gameId: 'rulezero' as const,
              phase: room.engine.getState().phase,
              specHash: room.engine.getState().specHash,
            }
          : room.engine.getState()
        : null,
  };
}

export interface RoomStore {
  save(room: Room): Promise<void>;
  load(roomId: string): Promise<RoomSnapshot | null>;
  delete(roomId: string): Promise<void>;
  listIds(): Promise<string[]>;
}

export class MemoryRoomStore implements RoomStore {
  private map = new Map<string, string>();

  async save(room: Room): Promise<void> {
    this.map.set(room.id, JSON.stringify(serializeRoom(room)));
  }

  async load(roomId: string): Promise<RoomSnapshot | null> {
    const raw = this.map.get(roomId);
    if (!raw) return null;
    return parseSnapshot(raw);
  }

  async delete(roomId: string): Promise<void> {
    this.map.delete(roomId);
  }

  async listIds(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

export class RedisRoomStore implements RoomStore {
  constructor(private redis: Redis, private ttlSeconds: number) {}

  async save(room: Room): Promise<void> {
    try {
      await this.redis.set(
        KEY_PREFIX + room.id,
        JSON.stringify(serializeRoom(room)),
        'EX',
        this.ttlSeconds,
      );
    } catch (err) {
      log.error('room_save_failed', { roomId: room.id, error: String(err) });
    }
  }

  async load(roomId: string): Promise<RoomSnapshot | null> {
    try {
      const raw = await this.redis.get(KEY_PREFIX + roomId);
      return raw ? parseSnapshot(raw) : null;
    } catch (err) {
      log.error('room_load_failed', { roomId, error: String(err) });
      return null;
    }
  }

  async delete(roomId: string): Promise<void> {
    try {
      await this.redis.del(KEY_PREFIX + roomId);
    } catch {
      /* best effort */
    }
  }

  async listIds(): Promise<string[]> {
    try {
      const keys = await this.redis.keys(KEY_PREFIX + '*');
      return keys.map((k: string) => k.slice(KEY_PREFIX.length));
    } catch {
      return [];
    }
  }
}

function parseSnapshot(raw: string): RoomSnapshot | null {
  try {
    const snap = JSON.parse(raw) as RoomSnapshot;
    if (snap.version !== SNAPSHOT_VERSION) {
      log.warn('snapshot_version_skipped', { found: snap.version });
      return null;
    }
    return snap;
  } catch (err) {
    log.error('snapshot_parse_failed', { error: String(err) });
    return null;
  }
}
