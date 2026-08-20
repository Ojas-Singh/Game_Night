/**
 * Room registry with TTL expiry and optional persistence. Backed by Redis
 * in production (REDIS_URL) so rooms survive app restarts; in-memory
 * fallback keeps single-node dev simple.
 */

import { Room, randomRoomCode } from './room.js';
import { log } from './log.js';
import type { RoomStore } from './persistence.js';

export class RoomManager {
  private rooms = new Map<string, Room>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private persister: ReturnType<typeof setInterval> | null = null;
  private ttlMs: number;
  private store: RoomStore | null = null;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  attachStore(store: RoomStore): void {
    this.store = store;
  }

  /** Restore persisted rooms after an app restart. */
  async restoreAll(): Promise<number> {
    if (!this.store) return 0;
    const ids = await this.store.listIds();
    let restored = 0;
    for (const id of ids) {
      const snap = await this.store.load(id);
      if (!snap) continue;
      if (Date.now() - snap.createdAt > this.ttlMs) {
        await this.store.delete(id);
        continue;
      }
      const room = Room.fromSnapshot(snap);
      this.rooms.set(room.id, room);
      restored++;
    }
    if (restored > 0) log.info('rooms_restored', { count: restored });
    return restored;
  }

  private persist(room: Room): void {
    if (!this.store) return;
    void this.store.save(room);
  }

  /** Public hook for the transport layer: snapshot after meaningful changes. */
  persistNow(room: Room): void {
    this.persist(room);
  }

  createRoom(): Room {
    let code: string;
    let guard = 0;
    do {
      code = randomRoomCode();
      guard++;
    } while (this.rooms.has(code) && guard < 100);
    const room = new Room({ roomId: code });
    this.rooms.set(code, room);
    this.persist(room);
    log.info('room_created', { roomId: code });
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    const room = this.rooms.get(roomId.toUpperCase());
    if (room && Date.now() - room.createdAt > this.ttlMs) {
      this.delete(room.id, 'expired');
      return undefined;
    }
    return room;
  }

  delete(roomId: string, reason: string): void {
    if (this.rooms.delete(roomId)) {
      if (this.store) void this.store.delete(roomId);
      log.info('room_deleted', { roomId, reason });
    }
  }

  /** Drop players whose reconnect grace elapsed and fully idle rooms. */
  sweep(): void {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      for (const p of [...room.players.values()]) {
        if (room.isExpiredPlayer(p, now) && !room.engine) {
          // Mid-game, keep the seat until the round would end; in lobby, drop.
          room.removePlayer(p.id);
        }
      }
      if (room.isIdle(now) || now - room.createdAt > this.ttlMs) {
        room.closed = true;
        this.delete(room.id, room.isIdle(now) ? 'abandoned' : 'expired');
      }
    }
  }

  startSweeper(intervalMs = 30_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    this.sweeper.unref?.();
    // Periodic snapshots keep restarts graceful even after idle periods.
    this.persister = setInterval(() => {
      for (const room of this.rooms.values()) this.persist(room);
    }, intervalMs / 3);
    this.persister.unref?.();
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.persister) clearInterval(this.persister);
    this.sweeper = null;
    this.persister = null;
  }

  get size(): number {
    return this.rooms.size;
  }
}
