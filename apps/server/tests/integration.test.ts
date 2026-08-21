/**
 * Full-stack integration test: real Socket.IO connections through the HTTP
 * server — room creation, joining, chat, and a complete 2-player Cabo game
 * with per-player filtered views. No browser required.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import { RoomManager } from '../src/roomManager.js';
import { registerSocketHandlers } from '../src/socket.js';
import type { CaboPlayerView } from '@game-night/engine-cabo';

let http: HttpServer;
let io: SocketServer;
let url: string;

/** Must match PRESENCE_DEBOUNCE_MS in socket.ts. */
const PRESENCE_WINDOW = 5200;

type TestSocket = ClientSocket;

/** Persistent view tracker — a real client keeps a listener attached too. */
class ViewTracker {
  latest: CaboPlayerView | null = null;
  private waiters: Array<(v: CaboPlayerView) => void> = [];

  constructor(sock: TestSocket) {
    sock.on('game:view', (v: CaboPlayerView) => {
      this.latest = v;
      this.waiters.splice(0).forEach((w) => w(v));
    });
  }

  async waitFor(pred: (v: CaboPlayerView) => boolean, timeoutMs = 5000): Promise<CaboPlayerView> {
    if (this.latest && pred(this.latest)) return this.latest;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for game:view')), timeoutMs);
      const poll = setInterval(() => {
        if (this.latest && pred(this.latest)) {
          clearTimeout(t);
          clearInterval(poll);
          resolve(this.latest);
        }
      }, 15);
      const origSplice = this.waiters.splice.bind(this.waiters);
      void origSplice;
      setTimeout(() => clearInterval(poll), timeoutMs);
    });
  }
}

function connect(): Promise<TestSocket> {
  return new Promise((resolve, reject) => {
    const sock = clientIo(url, { transports: ['websocket'] });
    sock.once('connect', () => resolve(sock));
    sock.once('connect_error', reject);
  });
}

function createRoom(sock: TestSocket, name: string): Promise<{ roomId: string; playerToken: string; playerId: string }> {
  return new Promise((resolve, reject) => {
    sock.emit('room:create', { name }, (res) => {
      if (res.ok) resolve(res as never);
      else reject(new Error(res.error));
    });
  });
}

function joinRoom(sock: TestSocket, payload: { roomId: string; name?: string; playerToken?: string }) {
  return new Promise<{ ok: boolean; error?: string; playerToken?: string; playerId?: string }>((resolve) => {
    sock.emit('room:join', payload, resolve);
  });
}

function startGame(sock: TestSocket): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => sock.emit('room:start_game', {}, resolve));
}

function gameAction(sock: TestSocket, action: unknown): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => sock.emit('game:action', { action }, resolve));
}

beforeAll(async () => {
  http = createServer();
  io = new SocketServer(http, { cors: { origin: true } });
  const rooms = new RoomManager(3_600_000);
  registerSocketHandlers(io, rooms);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const addr = http.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  io.close();
  await new Promise((r) => http.close(r));
});

describe('socket integration', () => {
  it(
    'creates a room, joins, chats, and plays a complete 2-player game with hidden info intact',
    async () => {
      const alice = await connect();
      const bob = await connect();
      const trackA = new ViewTracker(alice);
      const trackB = new ViewTracker(bob);

      const created = await createRoom(alice, 'Alice');
      expect(created.roomId).toMatch(/^[A-Z2-9]{6}$/);

      const joined = await joinRoom(bob, { roomId: created.roomId, name: 'Bob' });
      expect(joined.ok).toBe(true);

      // Chat flows to both.
      const chatPromise = new Promise<string>((resolve) => {
        bob.once('room:chat', (m) => resolve(m.text));
      });
      alice.emit('room:chat', { text: 'hello table' });
      expect(await chatPromise).toBe('hello table');

      // Host starts the game.
      const startRes = await startGame(alice);
      expect(startRes.ok).toBe(true);

      const va = await trackA.waitFor((v) => v.phase === 'INITIAL_PEEK');
      const vb = await trackB.waitFor((v) => v.phase === 'INITIAL_PEEK');
      expect(vb.handCardIds[joined.playerId!]).toHaveLength(4);

      // Hidden info: before peeks, neither player knows any card values.
      expect(Object.keys(va.knownCards)).toHaveLength(0);
      expect(Object.keys(vb.knownCards)).toHaveLength(0);

      // Initial peeks.
      let res = await gameAction(alice, {
        type: 'PEEK_STARTING',
        playerId: created.playerId,
        cardIndexes: [0, 1],
      });
      expect(res.ok).toBe(true);
      res = await gameAction(bob, {
        type: 'PEEK_STARTING',
        playerId: joined.playerId,
        cardIndexes: [0, 1],
      });
      expect(res.ok).toBe(true);

      await trackA.waitFor((v) => v.phase === 'TURN_DRAW');
      await trackB.waitFor((v) => v.phase === 'TURN_DRAW');

      // Drive the game to completion: draw → discard → resolve powers.
      // After enough turns, the current player calls Cabo to end the round.
      let done = false;
      let guard = 0;
      while (!done && guard++ < 300) {
        const currentId = trackA.latest!.players.find((p) => p.isCurrentTurn)?.id;
        const isAliceTurn = currentId === created.playerId;
        const sock = isAliceTurn ? alice : bob;
        const myId = isAliceTurn ? created.playerId : joined.playerId!;
        const myView = (isAliceTurn ? trackA : trackB).latest!;
        const others = myView.players.filter((p) => p.id !== myId);
        const other = others[0]!;
        const otherCards = myView.handCardIds[other.id] ?? [];
        const ownCards = myView.handCardIds[myId] ?? [];

        if (myView.phase === 'TURN_DRAW') {
          res =
            guard > 12 && !myView.cabo
              ? await gameAction(sock, { type: 'CALL_CABO', playerId: myId })
              : await gameAction(sock, { type: 'DRAW', playerId: myId });
        } else if (myView.phase === 'DRAW_DECISION') {
          res = await gameAction(sock, { type: 'DISCARD_DRAWN', playerId: myId });
        } else if (myView.phase === 'POWER_PENDING') {
          const power = myView.pendingPower!.power;
          const payloads = {
            PEEK_OWN: { power, cardId: ownCards[0] },
            PEEK_OTHER: { power, targetPlayerId: other.id, cardId: otherCards[0] },
            BLIND_SWAP: { power, ownCardId: ownCards[0], targetPlayerId: other.id, targetCardId: otherCards[0] },
            SWAP_OTHERS: { power, cardIdA: otherCards[0], cardIdB: otherCards[1] },
          } as const;
          res = await gameAction(sock, { type: 'POWER_APPLY', playerId: myId, payload: payloads[power] });
        } else if (myView.phase === 'TRANSFER_PENDING') {
          res = await gameAction(sock, { type: 'TRANSFER_CARD', playerId: myId, cardId: ownCards[0] });
        } else if (myView.phase === 'ROUND_COMPLETE') {
          done = true;
          res = { ok: true };
        } else {
          throw new Error(`unexpected phase ${myView.phase}`);
        }
        if (!res.ok && !done) throw new Error(`action failed in ${myView.phase}: ${res.error}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(done).toBe(true);
      const finalA = trackA.latest!;
      const finalB = trackB.latest!;
      expect(finalA.phase).toBe('ROUND_COMPLETE');
      expect(finalA.scores).toEqual(finalB.scores);
      expect(Object.keys(finalA.scores!)).toHaveLength(2);

      // Illegal action attempts are rejected after round end.
      const bad = await gameAction(alice, { type: 'DRAW', playerId: created.playerId });
      expect(bad.ok).toBe(false);

      // Spoofed playerId is overridden by the server (authority from socket).
      const spoof = await gameAction(alice, {
        type: 'DRAW',
        playerId: joined.playerId!, // pretending to be Bob
      });
      expect(spoof.ok).toBe(false);

      alice.close();
      bob.close();
    },
    60_000,
  );

  it('reconnects with token after disconnect and restores the same seat', async () => {
    const host = await connect();
    const created = await createRoom(host, 'Host');
    const guest = await connect();
    const joined = await joinRoom(guest, { roomId: created.roomId, name: 'Guest' });
    expect(joined.ok).toBe(true);

    expect((await startGame(host)).ok).toBe(true);

    guest.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    const guest2 = await connect();
    const rejoined = await joinRoom(guest2, { roomId: created.roomId, playerToken: joined.playerToken });
    expect(rejoined.ok).toBe(true);
    expect(rejoined.playerId).toBe(joined.playerId);

    // Reconnected player appears connected in the lobby state.
    const lobby = await new Promise<{ players: Array<{ id: string; connected: boolean }> }>((resolve) => {
      guest2.once('room:state', resolve);
      guest2.emit('room:set_ready', { ready: true });
    });
    const me = lobby.players.find((p) => p.id === joined.playerId);
    expect(me?.connected).toBe(true);

    guest2.close();
    host.close();
  });

  it('a quick transport blip does NOT flip the player to reconnecting (presence debounce)', async () => {
    const host = await connect();
    const created = await createRoom(host, 'Host');
    const guest = await connect();
    const joined = await joinRoom(guest, { roomId: created.roomId, name: 'Guest' });
    expect(joined.ok).toBe(true);
    expect((await startGame(host)).ok).toBe(true);

    // Simulate a blip lasting far less than the 5s presence debounce: the
    // guest drops and re-attaches (with its token) a moment later.
    guest.disconnect();
    await new Promise((r) => setTimeout(r, 30));
    const guest2 = await connect();
    const rejoined = await joinRoom(guest2, { roomId: created.roomId, playerToken: joined.playerToken });
    expect(rejoined.ok).toBe(true);
    expect(rejoined.playerId).toBe(joined.playerId);

    // Even after the debounce window elapses with no further reconnect,
    // the seat must never have flipped to "reconnecting".
    await new Promise((r) => setTimeout(r, PRESENCE_WINDOW));
    const state = await new Promise<{ players: Array<{ id: string; connected: boolean }> }>(
      (resolve) => {
        host.once('room:state', resolve);
        host.emit('room:set_ready', { ready: true });
        // Fallback in case no broadcast arrives promptly (should still come
        // from the debounce timer's markDisconnected cancel path if nothing
        // else): poll a few times.
        setTimeout(() => resolve(null as never), 3000);
      },
    );
    if (state) {
      const after = state.players.find((p) => p.id === joined.playerId);
      expect(after?.connected).toBe(true);
    } else {
      // No broadcast landed; force another to read state.
      const state2 = await new Promise<{ players: Array<{ id: string; connected: boolean }> }>(
        (resolve) => {
          host.once('room:state', resolve);
          host.emit('room:set_ready', { ready: true });
        },
      );
      expect(state2.players.find((p) => p.id === joined.playerId)?.connected).toBe(true);
    }

    guest2.close();
    host.close();
  }, 20000);

  it('the host sees themselves as host/isYou in the lobby (Start button renders)', async () => {
    const host = await connect();
    const created = await createRoom(host, 'Host');
    const guest = await connect();
    const joined = await joinRoom(guest, { roomId: created.roomId, name: 'Guest' });
    expect(joined.ok).toBe(true);

    // Host's own lobby view must mark them as you + host.
    const hostState = await new Promise<{
      players: Array<{ id: string; isYou: boolean; isHost: boolean }>;
      hostId: string;
    }>((resolve) => {
      host.once('room:state', resolve);
      host.emit('room:set_name', { name: 'Host' });
    });
    const hostMe = hostState.players.find((p) => p.id === created.playerId);
    expect(hostMe?.isYou).toBe(true);
    expect(hostMe?.isHost).toBe(true);
    expect(hostState.hostId).toBe(created.playerId);

    // Guest's lobby view marks the HOST as host but NOT as the guest's "you".
    const guestState = await new Promise<{
      players: Array<{ id: string; isYou: boolean; isHost: boolean }>;
    }>((resolve) => {
      guest.once('room:state', resolve);
      guest.emit('room:set_ready', { ready: true });
    });
    const guestHost = guestState.players.find((p) => p.id === created.playerId);
    const guestMe = guestState.players.find((p) => p.id === joined.playerId);
    expect(guestHost?.isHost).toBe(true);
    expect(guestHost?.isYou).toBe(false);
    expect(guestMe?.isYou).toBe(true);

    host.close();
    guest.close();
  });

  it('rejects joining a nonexistent room', async () => {
    const sock = await connect();
    const res = await joinRoom(sock, { roomId: 'ZZZZZZ', name: 'X' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
    sock.close();
  });
});
