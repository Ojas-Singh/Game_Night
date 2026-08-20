/**
 * Room registry with TTL expiry. In-memory by design for the MVP; Redis
 * (state + pub/sub) can back the same interface later for horizontal scaling.
 */

import { Room, randomRoomCode } from './room.js';
import { log } from './log.js';

export class RoomManager {
  private rooms = new Map<string, Room>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
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
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  get size(): number {
    return this.rooms.size;
  }
}
