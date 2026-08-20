import { describe, expect, it } from 'vitest';
import { Room, RoomError, randomRoomCode } from '../src/room.js';
import { RoomManager } from '../src/roomManager.js';

describe('room codes', () => {
  it('generates 6-char unambiguous codes', () => {
    for (let i = 0; i < 50; i++) {
      const code = randomRoomCode();
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });
});

describe('Room', () => {
  it('first player becomes host; join messages recorded', () => {
    const room = new Room({ roomId: 'TEST01' });
    const { player: p1 } = room.addPlayer('Ojas');
    const { player: p2 } = room.addPlayer('Subee');
    expect(room.hostId).toBe(p1.id);
    expect(room.chat.map((m) => m.text)).toEqual([
      'Ojas created the room',
      'Subee joined',
    ]);
  });

  it('reconnects via secret player token and keeps the seat', () => {
    const room = new Room({ roomId: 'TEST02' });
    const { player: p1 } = room.addPlayer('Alex');
    room.markDisconnected(p1.id);
    expect(room.players.get(p1.id)!.connected).toBe(false);
    const { player, reconnected } = room.addPlayer(undefined, p1.token);
    expect(reconnected).toBe(true);
    expect(player.id).toBe(p1.id);
    expect(room.players.get(p1.id)!.connected).toBe(true);
  });

  it('rejects mid-game joins without a valid token', () => {
    const room = new Room({ roomId: 'TEST03' });
    room.addPlayer('A');
    room.addPlayer('B');
    room.startGame(room.hostId!);
    expect(() => room.addPlayer('C')).toThrow(RoomError);
    // Reconnect still works mid-game with a valid token.
    const tokenA = [...room.players.values()].find((p) => p.name === 'A')!.token;
    const { player: ra, reconnected } = room.addPlayer(undefined, tokenA);
    expect(reconnected).toBe(true);
    expect(ra.name).toBe('A');
    expect(room.players.size).toBe(2);
  });

  it('reassigns host when the host leaves', () => {
    const room = new Room({ roomId: 'TEST04' });
    const { player: p1 } = room.addPlayer('First');
    const { player: p2 } = room.addPlayer('Second');
    room.removePlayer(p1.id);
    expect(room.hostId).toBe(p2.id);
    expect(room.chat.at(-1)!.text).toBe('Second is now the host');
  });

  it('only the host can start, with enough players', () => {
    const room = new Room({ roomId: 'TEST05' });
    const { player: p1 } = room.addPlayer('A');
    const { player: p2 } = room.addPlayer('B');
    expect(() => room.startGame(p2.id)).toThrow(/host/);
    room.removePlayer(p2.id);
    expect(() => room.startGame(p1.id)).toThrow(/at least 2/);
    const { player: p3 } = room.addPlayer('C');
    room.startGame(p1.id);
    expect(room.engine).not.toBeNull();
    expect(room.lobbyState().inGame).toBe(true);
  });

  it('handles full-room rejection', () => {
    const room = new Room({ roomId: 'TEST06', reconnectGraceMs: 0 });
    for (let i = 0; i < 6; i++) room.addPlayer(`P${i}`);
    expect(() => room.addPlayer('Extra')).toThrow(/full/);
  });

  it('name changes are sanitized and announced', () => {
    const room = new Room({ roomId: 'TEST07' });
    const { player } = room.addPlayer('Alex');
    room.setName(player.id, '  Alex   S ');
    expect(room.players.get(player.id)!.name).toBe('Alex S');
    expect(room.chat.at(-1)!.text).toBe('Alex changed their name to Alex S');
    expect(() => room.setName(player.id, '')).toThrow(/name/);
  });

  it('expired players are identified for the sweeper', () => {
    const room = new Room({ roomId: 'TEST08', reconnectGraceMs: 100 });
    const { player } = room.addPlayer('A');
    expect(room.isExpiredPlayer(room.players.get(player.id)!)).toBe(false);
    room.markDisconnected(player.id);
    expect(room.isExpiredPlayer(room.players.get(player.id)!)).toBe(false);
    // Simulate time passing beyond the grace period.
    room.players.get(player.id)!.disconnectedAt = Date.now() - 1000;
    expect(room.isExpiredPlayer(room.players.get(player.id)!)).toBe(true);
  });

  it('chat truncates long input and drops empty', () => {
    const room = new Room({ roomId: 'TEST09' });
    const { player } = room.addPlayer('A');
    expect(room.playerChat(player.id, '   ')).toBeNull();
    const long = 'x'.repeat(600);
    const msg = room.playerChat(player.id, long)!;
    expect(msg.text.length).toBe(500);
  });
});

function ra_id(room: Room, name: string): string | undefined {
  for (const p of room.players.values()) if (p.name === name) return p.id;
  return undefined;
}
void ra_id;

describe('RoomManager', () => {
  it('creates, resolves case-insensitively, and deletes', () => {
    const mgr = new RoomManager(60_000);
    const room = mgr.createRoom();
    expect(mgr.getRoom(room.id.toLowerCase())).toBeDefined();
    mgr.delete(room.id, 'test');
    expect(mgr.getRoom(room.id)).toBeUndefined();
  });

  it('expires rooms past TTL', async () => {
    const mgr = new RoomManager(1);
    const room = mgr.createRoom();
    await new Promise((r) => setTimeout(r, 5));
    expect(mgr.getRoom(room.id)).toBeUndefined();
  });

  it('sweeps idle rooms and grace-expired lobby players', () => {
    const mgr = new RoomManager(3_600_000);
    const room = mgr.createRoom();
    const { player } = room.addPlayer('Ghost');
    room.markDisconnected(player.id);
    room.players.get(player.id)!.disconnectedAt = Date.now() - 10 * 60_000;
    room.engine = null;
    mgr.sweep();
    expect(room.players.size).toBe(0);
    expect(mgr.getRoom(room.id)).toBeUndefined();
  });
});
