/**
 * The drawing studio: op checks and ordering, undo ownership, side-by-side
 * canvases, flattening, snapshots, and the socket round trip between two
 * clients.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import type { DrawOp, StudioSnapshot, StudioState } from '@game-night/shared';
import { STUDIO_LIMITS } from '@game-night/shared';
import { Studio, StudioError } from '../src/studio/studio.js';
import { Room } from '../src/room.js';
import { serializeRoom } from '../src/persistence.js';
import { RoomManager } from '../src/roomManager.js';
import { registerSocketHandlers } from '../src/socket.js';
import { MemoryAssetStore, sniffImage } from '../src/studio/assets.js';

const stroke = (n = 3) => ({
  kind: 'stroke', brush: 'ink-pen', color: '#112233', size: 8, opacity: 1, erase: false, seed: 9,
  points: Array.from({ length: n }, (_, i) => [10 + i, 20 + i, 0.5, 0, 0]).flat(),
});

function openStudio(): Studio {
  const s = new Studio();
  s.state.open = true;
  return s;
}

describe('Studio model', () => {
  it('numbers ops in arrival order and keeps them', () => {
    const s = openStudio();
    const a = s.addOp('p1', { id: 'a', canvas: 'main', layer: 'ink', body: stroke() });
    const b = s.addOp('p2', { id: 'b', canvas: 'main', layer: 'paint', body: stroke() });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(s.ops.map((o) => o.id)).toEqual(['a', 'b']);
    expect(a.by).toBe('p1');
  });

  it('rejects bad ops', () => {
    const s = openStudio();
    const bad = (body: unknown, extra: Record<string, unknown> = {}) =>
      () => s.addOp('p', { id: `x${Math.random().toString(36).slice(2, 8)}`, canvas: 'main', layer: 'ink', body, ...extra });
    expect(bad({ ...stroke(), color: 'red' })).toThrow(StudioError);
    expect(bad({ ...stroke(), size: 0 })).toThrow(StudioError);
    expect(bad({ ...stroke(), points: [1, 2, 3] })).toThrow(StudioError);
    expect(bad({ ...stroke(), points: [1, 2, 0.5, 0, Number.NaN] })).toThrow(StudioError);
    expect(bad({ ...stroke(), brush: '../../etc' })).toThrow(StudioError);
    expect(bad(stroke(), { layer: 'nope' })).toThrow(StudioError);
    expect(bad(stroke(), { canvas: 'nope' })).toThrow(StudioError);
    expect(bad({ kind: 'fill', color: '#000000', opacity: 1, x: 0, y: 0, w: 10, h: 10, runs: [50, 51] })).toThrow(StudioError);
    expect(bad({ kind: 'fill', color: '#000000', opacity: 1, x: 1599, y: 0, w: 10, h: 10, runs: [1] })).toThrow(StudioError);
    expect(bad({ kind: 'warp' })).toThrow(StudioError);
    expect(s.ops).toHaveLength(0);
  });

  it('refuses ops while closed and duplicate ids', () => {
    const s = new Studio();
    expect(() => s.addOp('p', { id: 'a', canvas: 'main', layer: 'ink', body: stroke() })).toThrow(/closed/);
    s.state.open = true;
    s.addOp('p', { id: 'a', canvas: 'main', layer: 'ink', body: stroke() });
    expect(() => s.addOp('p', { id: 'a', canvas: 'main', layer: 'ink', body: stroke() })).toThrow(/duplicate/);
  });

  it('lets people undo only their own ops', () => {
    const s = openStudio();
    s.addOp('p1', { id: 'a', canvas: 'main', layer: 'ink', body: stroke() });
    expect(() => s.toggle('p2', 'a', true)).toThrow(/your own/);
    expect(s.toggle('p1', 'a', true).undone).toBe(true);
    expect(s.toggle('p1', 'a', false).undone).toBeUndefined();
  });

  it('gives each person a canvas in side-by-side mode, and keeps others off it', () => {
    const s = openStudio();
    expect(s.setup({ mode: 'side-by-side' }).wiped).toBe(true);
    expect(s.state.canvases).toHaveLength(0);
    const mine = s.canvasFor('p1');
    expect(s.canvasFor('p1')).toBe(mine);
    expect(mine.ownerId).toBe('p1');
    s.addOp('p1', { id: 'a', canvas: mine.id, layer: 'ink', body: stroke() });
    expect(() => s.addOp('p2', { id: 'b', canvas: mine.id, layer: 'ink', body: stroke() })).toThrow(/belongs/);
    expect(() => s.editLayers('p2', { kind: 'update', canvas: mine.id, layer: 'ink', patch: { visible: false } })).toThrow(/belongs/);
  });

  it('switching between shared modes keeps the drawing; size changes wipe it', () => {
    const s = openStudio();
    s.addOp('p1', { id: 'a', canvas: 'main', layer: 'ink', body: stroke() });
    expect(s.setup({ mode: 'colouring' }).wiped).toBe(false);
    expect(s.ops).toHaveLength(1);
    const epoch = s.state.epoch;
    expect(s.setup({ width: 1200, height: 1600 }).wiped).toBe(true);
    expect(s.ops).toHaveLength(0);
    expect(s.state.epoch).toBe(epoch + 1);
    expect(s.setup({ width: 99999 }).wiped).toBe(true);
    expect(s.state.width).toBe(STUDIO_LIMITS.maxSide);
  });

  it('edits layers and drops a removed layer’s ops', () => {
    const s = openStudio();
    s.editLayers('p', { kind: 'add', canvas: 'main', index: 2, layer: { id: 'sky', name: '  Sky  ', visible: true, opacity: 1, blend: 'normal', base: null } });
    expect(s.state.canvases[0]!.layers.map((l) => l.id)).toEqual(['paint', 'ink', 'sky']);
    expect(s.state.canvases[0]!.layers[2]!.name).toBe('Sky');
    s.addOp('p', { id: 'a', canvas: 'main', layer: 'sky', body: stroke() });
    s.editLayers('p', { kind: 'update', canvas: 'main', layer: 'sky', patch: { opacity: 7, blend: 'multiply' } });
    expect(s.state.canvases[0]!.layers[2]).toMatchObject({ opacity: 1, blend: 'multiply' });
    s.editLayers('p', { kind: 'move', canvas: 'main', layer: 'sky', index: 0 });
    expect(s.state.canvases[0]!.layers[0]!.id).toBe('sky');
    s.editLayers('p', { kind: 'remove', canvas: 'main', layer: 'sky' });
    expect(s.ops).toHaveLength(0);
    s.editLayers('p', { kind: 'remove', canvas: 'main', layer: 'ink' });
    expect(() => s.editLayers('p', { kind: 'remove', canvas: 'main', layer: 'paint' })).toThrow(/at least one/);
  });

  it('asks for a bake when the log is long and replaces old ops with layer images', () => {
    const s = openStudio();
    for (let i = 0; i < STUDIO_LIMITS.bakeAt; i++) s.addOp('p', { id: `o${i}`, canvas: 'main', layer: 'ink', body: stroke() });
    const want = s.bakeCandidate();
    expect(want).toEqual({ canvas: 'main', upTo: STUDIO_LIMITS.bakeAt - STUDIO_LIMITS.keepAfterBake });
    expect(s.bakeCandidate()).toBeNull(); // asked once
    const known = new Set(['img-paint', 'img-ink']);
    expect(() => s.bake({ canvas: 'main', upTo: want!.upTo, layers: { paint: 'img-paint' } }, (id) => known.has(id))).toThrow(/missing/);
    s.bake({ canvas: 'main', upTo: want!.upTo, layers: { paint: 'img-paint', ink: 'img-ink' } }, (id) => known.has(id));
    expect(s.ops).toHaveLength(STUDIO_LIMITS.keepAfterBake);
    expect(s.ops[0]!.seq).toBe(want!.upTo + 1);
    expect(s.state.canvases[0]!.layers.map((l) => l.base)).toEqual(['img-paint', 'img-ink']);
    expect(s.assetsInUse()).toEqual(new Set(['img-paint', 'img-ink']));
  });

  it('survives a room snapshot round trip', () => {
    const room = new Room({ roomId: 'ABCDEF' });
    room.addPlayer('Ana');
    room.studio = openStudio();
    room.studio.addOp('p', { id: 'a', canvas: 'main', layer: 'ink', body: stroke() });
    const snap = JSON.parse(JSON.stringify(serializeRoom(room)));
    const back = Room.fromSnapshot(snap);
    expect(back.studio?.state.open).toBe(true);
    expect(back.studio?.ops.map((o) => o.id)).toEqual(['a']);
    const next = back.studio!.addOp('p', { id: 'b', canvas: 'main', layer: 'ink', body: stroke() });
    expect(next.seq).toBe(2);
    expect(back.lobbyState().studio).toEqual({ open: true, mode: 'together' });
  });

  it('seats more artists in an open studio than at a card table', () => {
    const room = new Room({ roomId: 'ABCDEF' });
    for (let i = 0; i < 6; i++) room.addPlayer(`P${i}`);
    expect(() => room.addPlayer('Seventh')).toThrow(/full/);
    room.studio = openStudio();
    room.addPlayer('Seventh');
    expect(room.players.size).toBe(7);
    expect(() => room.startGame(room.hostId!)).toThrow(/at most/);
  });

  it('recognises image uploads by their bytes', () => {
    expect(sniffImage(Buffer.from('89504e470d0a1a0a0000', 'hex'))).toBe('image/png');
    expect(sniffImage(Buffer.from('ffd8ffe000104a464946', 'hex'))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Socket round trip
// ---------------------------------------------------------------------------

let http: HttpServer;
let io: SocketServer;
let url: string;

beforeAll(async () => {
  http = createServer();
  io = new SocketServer(http);
  registerSocketHandlers(io, new RoomManager(60_000), { assets: new MemoryAssetStore() });
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const addr = http.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  io.close();
  await new Promise((resolve) => http.close(resolve));
});

function connect(): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const sock = clientIo(url, { transports: ['websocket'] });
    sock.once('connect', () => resolve(sock));
    sock.once('connect_error', reject);
  });
}

type Res = { ok: boolean; error?: string; [k: string]: unknown };
const call = (sock: ClientSocket, event: string, payload: unknown) =>
  new Promise<Res>((resolve) => sock.emit(event, payload, resolve));

describe('Studio over sockets', () => {
  it('opens for the host, relays ops in one order to everyone, and undoes', async () => {
    const host = await connect();
    const guest = await connect();
    const made = await call(host, 'room:create', { name: 'Host' });
    const roomId = String(made.roomId);
    expect((await call(guest, 'room:join', { roomId, name: 'Guest' })).ok).toBe(true);

    expect((await call(guest, 'draw:open', {})).error).toMatch(/host/);
    const states: StudioState[] = [];
    guest.on('draw:state', (s: StudioState) => states.push(s));
    expect((await call(host, 'draw:open', { setup: { mode: 'together', paper: 'kraft' } })).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(states.at(-1)).toMatchObject({ open: true, paper: 'kraft' });

    const seenByHost: DrawOp[] = [];
    const seenByGuest: DrawOp[] = [];
    host.on('draw:op', (op: DrawOp) => seenByHost.push(op));
    guest.on('draw:op', (op: DrawOp) => seenByGuest.push(op));
    const [a, b] = await Promise.all([
      call(host, 'draw:op', { id: 'h1', canvas: 'main', layer: 'ink', body: stroke() }),
      call(guest, 'draw:op', { id: 'g1', canvas: 'main', layer: 'paint', body: stroke() }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(seenByHost.map((o) => o.id)).toEqual(seenByGuest.map((o) => o.id));
    expect(seenByHost).toHaveLength(2);

    expect((await call(guest, 'draw:toggle', { opId: 'h1', undone: true })).ok).toBe(false);
    const toggles: unknown[] = [];
    guest.on('draw:toggle', (t: unknown) => toggles.push(t));
    expect((await call(host, 'draw:toggle', { opId: 'h1', undone: true })).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(toggles).toEqual([{ opId: 'h1', undone: true }]);

    const sync = await call(guest, 'draw:sync', {});
    const snap = sync.snapshot as StudioSnapshot;
    expect(snap.ops.map((o) => [o.id, !!o.undone])).toEqual([['h1', true], ['g1', false]]);

    // Live strokes go to the others only, never stored.
    const live: unknown[] = [];
    guest.on('draw:live', (l: unknown) => live.push(l));
    host.emit('draw:live', { id: 'h2', canvas: 'main', layer: 'ink', points: [1, 2, 0.5, 0, 0] });
    await new Promise((r) => setTimeout(r, 50));
    expect(live).toHaveLength(1);

    expect((await call(host, 'draw:close', {})).ok).toBe(true);
    expect((await call(guest, 'draw:op', { id: 'g2', canvas: 'main', layer: 'ink', body: stroke() })).error).toMatch(/closed/);
    host.close();
    guest.close();
  });
});
