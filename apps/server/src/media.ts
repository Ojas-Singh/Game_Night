/**
 * MediaMesh — per-room membership for the peer-to-peer voice/video mesh.
 *
 * The server NEVER touches media: it only tracks who is in the mesh and
 * relays WebRTC signaling between member sockets. A member may own several
 * sockets (multi-tab); the member leaves when its last socket goes.
 */

/** Cap signaling relays per socket (offers/answers/ICE candidates). */
const SIGNAL_BURST = 120;
const SIGNAL_REFILL_PER_SEC = 60;

export interface MediaMemberInfo {
  playerId: string;
  mic: boolean;
  cam: boolean;
  socketIds: string[];
}

interface MediaMember {
  playerId: string;
  mic: boolean;
  cam: boolean;
  socketIds: Set<string>;
}

interface SignalBucket {
  tokens: number;
  updatedAt: number;
}

export class MediaMesh {
  private rooms = new Map<string, Map<string, MediaMember>>();
  private buckets = new Map<string, SignalBucket>();

  /**
   * Add a socket to the room's mesh. Returns the full member list EXCLUDING
   * the joiner (they are the newcomer and will initiate offers to these).
   */
  join(roomId: string, playerId: string, socketId: string, media: { mic: boolean; cam: boolean }): MediaMemberInfo[] {
    const room = this.room(roomId);
    const existing = room.get(playerId);
    if (existing) {
      existing.socketIds.add(socketId);
      // Re-join with fresh toggles — treat the latest intent as authoritative.
      existing.mic = media.mic;
      existing.cam = media.cam;
    } else {
      room.set(playerId, { playerId, ...media, socketIds: new Set([socketId]) });
    }
    return this.members(roomId).filter((member) => member.playerId !== playerId);
  }

  /**
   * Remove one socket. Returns true when this was the member's last socket
   * (the member fully left the mesh and others should tear down its peer).
   */
  leaveSocket(roomId: string, playerId: string, socketId: string): boolean {
    const room = this.rooms.get(roomId);
    const member = room?.get(playerId);
    if (!room || !member) return false;
    member.socketIds.delete(socketId);
    if (member.socketIds.size > 0) return false;
    room.delete(playerId);
    if (room.size === 0) this.rooms.delete(roomId);
    return true;
  }

  /** Remove a member entirely (kick / room leave) regardless of sockets. */
  removeMember(roomId: string, playerId: string): boolean {
    const room = this.rooms.get(roomId);
    return room ? room.delete(playerId) : false;
  }

  update(roomId: string, playerId: string, media: { mic: boolean; cam: boolean }): void {
    const member = this.rooms.get(roomId)?.get(playerId);
    if (!member) return;
    member.mic = media.mic;
    member.cam = media.cam;
  }

  members(roomId: string): MediaMemberInfo[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.values()].map((member) => ({
      playerId: member.playerId,
      mic: member.mic,
      cam: member.cam,
      socketIds: [...member.socketIds],
    }));
  }

  /** true when the signaling relay should accept this socket's message. */
  allowSignal(socketId: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(socketId) ?? { tokens: SIGNAL_BURST, updatedAt: now };
    const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1_000);
    bucket.tokens = Math.min(SIGNAL_BURST, bucket.tokens + elapsedSec * SIGNAL_REFILL_PER_SEC);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      this.buckets.set(socketId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(socketId, bucket);
    return true;
  }

  forgetSocket(socketId: string): void {
    this.buckets.delete(socketId);
  }

  private room(roomId: string): Map<string, MediaMember> {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Map();
      this.rooms.set(roomId, room);
    }
    return room;
  }
}
