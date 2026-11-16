/**
 * Studio pictures and flattened layers: small binary blobs per room, kept in
 * Redis next to the room snapshots (same expiry) or in memory without Redis.
 */

import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { log } from '../log.js';

const KEY_PREFIX = 'game-night:asset:';

export interface AssetStore {
  put(roomId: string, data: Buffer): Promise<string>;
  get(roomId: string, id: string): Promise<Buffer | null>;
  /** Known to exist (cheap check used when a bake names its layers). */
  has(roomId: string, id: string): boolean;
  /** Forget every asset of a room that is not in `keep`. */
  prune(roomId: string, keep: Set<string>): Promise<void>;
}

/** The image type from its first bytes, or null for anything else. */
export function sniffImage(data: Buffer): string | null {
  if (data.length > 8 && data[0] === 0x89 && data.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length > 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function newId(): string {
  return randomBytes(12).toString('base64url');
}

export class MemoryAssetStore implements AssetStore {
  private rooms = new Map<string, Map<string, Buffer>>();

  async put(roomId: string, data: Buffer): Promise<string> {
    const id = newId();
    let room = this.rooms.get(roomId);
    if (!room) this.rooms.set(roomId, (room = new Map()));
    room.set(id, data);
    return id;
  }

  async get(roomId: string, id: string): Promise<Buffer | null> {
    return this.rooms.get(roomId)?.get(id) ?? null;
  }

  has(roomId: string, id: string): boolean {
    return this.rooms.get(roomId)?.has(id) ?? false;
  }

  async prune(roomId: string, keep: Set<string>): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const id of room.keys()) if (!keep.has(id)) room.delete(id);
    if (room.size === 0) this.rooms.delete(roomId);
  }
}

export class RedisAssetStore implements AssetStore {
  /** Ids written or read by this process, for `has` without a round trip. */
  private known = new Map<string, Set<string>>();

  constructor(private redis: Redis, private ttlSeconds: number) {}

  private remember(roomId: string, id: string): void {
    let set = this.known.get(roomId);
    if (!set) this.known.set(roomId, (set = new Set()));
    set.add(id);
  }

  async put(roomId: string, data: Buffer): Promise<string> {
    const id = newId();
    await this.redis.set(`${KEY_PREFIX}${roomId}:${id}`, data, 'EX', this.ttlSeconds);
    this.remember(roomId, id);
    return id;
  }

  async get(roomId: string, id: string): Promise<Buffer | null> {
    try {
      const key = `${KEY_PREFIX}${roomId}:${id}`;
      const data = await this.redis.getBuffer(key);
      if (data) {
        this.remember(roomId, id);
        // Pictures live as long as the room does.
        void this.redis.expire(key, this.ttlSeconds);
      }
      return data;
    } catch (err) {
      log.error('asset_load_failed', { roomId, error: String(err) });
      return null;
    }
  }

  has(roomId: string, id: string): boolean {
    return this.known.get(roomId)?.has(id) ?? false;
  }

  async prune(roomId: string, keep: Set<string>): Promise<void> {
    const set = this.known.get(roomId);
    if (!set) return;
    const drop = [...set].filter((id) => !keep.has(id));
    for (const id of drop) set.delete(id);
    if (drop.length) {
      try {
        await this.redis.del(...drop.map((id) => `${KEY_PREFIX}${roomId}:${id}`));
      } catch { /* expiry cleans up */ }
    }
  }
}
