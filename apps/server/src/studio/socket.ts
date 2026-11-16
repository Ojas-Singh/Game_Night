/**
 * Socket events of the drawing studio. Ops are numbered by the room's Studio
 * and sent to everyone, the sender included, so all clients apply them in the
 * same order. Strokes in progress and cursors are relayed without storing.
 */

import type { Server as SocketServer, Socket } from 'socket.io';
import type { DrawOp, LayerEdit, LiveStroke, StudioBake, StudioCursor, StudioSetup } from '@game-night/shared';
import type { Room } from '../room.js';
import { RoomError } from '../room.js';
import { Studio, StudioError } from './studio.js';
import type { AssetStore } from './assets.js';
import { log } from '../log.js';

type Ack = ((res: { ok: boolean; error?: string; [k: string]: unknown }) => void) | undefined;

export interface StudioContext {
  io: SocketServer;
  assets: AssetStore;
  requireRoom: () => { room: Room; playerId: string };
  broadcastLobby: (room: Room) => void;
  system: (room: Room, text: string) => void;
}

/** Send the studio's settings (layers, picture, mode) to the whole room. */
export function broadcastStudioState(io: SocketServer, room: Room): void {
  if (room.studio) io.to(room.id).emit('draw:state', room.studio.state);
}

export function registerStudioHandlers(socket: Socket, ctx: StudioContext): void {
  const { io } = ctx;

  const guard = (ack: Ack, fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      const known = err instanceof StudioError || err instanceof RoomError;
      if (!known) log.error('studio_error', { error: String((err as Error)?.stack ?? err) });
      ack?.({ ok: false, error: known ? (err as Error).message : 'internal error' });
    }
  };

  const studioOf = (room: Room): Studio => {
    if (!room.studio) throw new StudioError('the studio is not set up');
    return room.studio;
  };

  const hostOnly = (room: Room, playerId: string): void => {
    if (room.hostId !== playerId) throw new StudioError('only the host can do that');
  };

  /** Ask one connected person to flatten old ops when the log is long. */
  const maybeAskForBake = (room: Room, studio: Studio, op: DrawOp): void => {
    const want = studio.bakeCandidate();
    if (!want) return;
    const canvas = studio.state.canvases.find((c) => c.id === want.canvas);
    const order = [canvas?.ownerId, room.hostId, op.by].filter((x): x is string => !!x);
    for (const id of order) {
      const p = room.participant(id);
      const sid = p && [...p.sockets][0];
      if (sid) {
        io.to(sid).emit('draw:bake_request', want);
        return;
      }
    }
  };

  socket.on('draw:open', (payload: { setup?: StudioSetup } | undefined, ack: Ack) => guard(ack, () => {
    const { room, playerId } = ctx.requireRoom();
    hostOnly(room, playerId);
    if (room.engine) throw new StudioError('finish the card game first');
    room.studio ??= new Studio();
    if (payload?.setup) room.studio.setup(payload.setup);
    room.studio.state.open = true;
    ctx.system(room, 'The studio is open — grab a brush!');
    ack?.({ ok: true });
    ctx.broadcastLobby(room);
    broadcastStudioState(io, room);
  }));

  socket.on('draw:close', (_payload: unknown, ack: Ack) => guard(ack, () => {
    const { room, playerId } = ctx.requireRoom();
    hostOnly(room, playerId);
    const studio = studioOf(room);
    studio.state.open = false;
    ctx.system(room, 'The host closed the studio (the drawing is kept)');
    ack?.({ ok: true });
    ctx.broadcastLobby(room);
    broadcastStudioState(io, room);
  }));

  socket.on('draw:setup', (patch: StudioSetup, ack: Ack) => guard(ack, () => {
    const { room, playerId } = ctx.requireRoom();
    hostOnly(room, playerId);
    room.studio ??= new Studio();
    const { wiped } = room.studio.setup(patch ?? {});
    ack?.({ ok: true });
    if (wiped) io.to(room.id).emit('draw:snapshot', room.studio.snapshot());
    else broadcastStudioState(io, room);
    ctx.broadcastLobby(room);
  }));

  /** Host wipes every canvas (a fresh start, same settings). */
  socket.on('draw:wipe', (_payload: unknown, ack: Ack) => guard(ack, () => {
    const { room, playerId } = ctx.requireRoom();
    hostOnly(room, playerId);
    const studio = studioOf(room);
    studio.wipe();
    ctx.system(room, 'The host started a fresh canvas');
    ack?.({ ok: true });
    io.to(room.id).emit('draw:snapshot', studio.snapshot());
  }));

  socket.on('draw:sync', (_payload: unknown, ack: Ack) => guard(ack, () => {
    const { room } = ctx.requireRoom();
    ack?.({ ok: true, snapshot: room.studio?.snapshot() ?? null });
  }));

  /** Side by side: make (or find) my own canvas. */
  socket.on('draw:mine', (_payload: unknown, ack: Ack) => guard(ack, () => {
    const { room, playerId } = ctx.requireRoom();
    const studio = studioOf(room);
    const before = studio.state.canvases.length;
    const canvas = studio.canvasFor(playerId);
    ack?.({ ok: true, canvas: canvas.id });
    if (studio.state.canvases.length !== before) broadcastStudioState(io, room);
  }));

  socket.on('draw:op', (payload: { id: unknown; canvas: unknown; layer: unknown; body: unknown }, ack: Ack) => guard(ack, () => {
    const { room, playerId } = ctx.requireRoom();
    const studio = studioOf(room);
    const op = studio.addOp(playerId, payload ?? ({} as never));
    ack?.({ ok: true, seq: op.seq });
    io.to(room.id).emit('draw:op', op);
    maybeAskForBake(room, studio, op);
  }));

  socket.on('draw:toggle', (payload: { opId: string; undone: boolean }, ack: Ack) => guard(ack, () => {
    const { room, playerId } = ctx.requireRoom();
    const op = studioOf(room).toggle(playerId, String(payload?.opId), !!payload?.undone);
    ack?.({ ok: true });
    io.to(room.id).emit('draw:toggle', { opId: op.id, undone: !!op.undone });
  }));

  socket.on('draw:layers', (edit: LayerEdit, ack: Ack) => guard(ack, () => {
    const { room, playerId } = ctx.requireRoom();
    studioOf(room).editLayers(playerId, edit);
    ack?.({ ok: true });
    broadcastStudioState(io, room);
  }));

  socket.on('draw:bake', (bake: StudioBake, ack: Ack) => guard(ack, () => {
    const { room } = ctx.requireRoom();
    const studio = studioOf(room);
    studio.bake(bake, (id) => ctx.assets.has(room.id, id));
    ack?.({ ok: true });
    io.to(room.id).emit('draw:baked', { canvas: bake.canvas, upTo: bake.upTo, state: studio.state });
    void ctx.assets.prune(room.id, studio.assetsInUse());
    log.info('studio_baked', { roomId: room.id, canvas: bake.canvas, upTo: bake.upTo, opsLeft: studio.ops.length });
  }));

  socket.on('draw:live', (live: LiveStroke) => {
    try {
      const { room, playerId } = ctx.requireRoom();
      if (!room.studio?.state.open || !live || typeof live.id !== 'string') return;
      if (!Array.isArray(live.points) || live.points.length > 4000) return;
      socket.to(room.id).emit('draw:live', { ...live, by: playerId });
    } catch { /* not in a room */ }
  });

  socket.on('draw:cursor', (cursor: StudioCursor) => {
    try {
      const { room, playerId } = ctx.requireRoom();
      if (!room.studio?.state.open || !cursor) return;
      socket.to(room.id).volatile.emit('draw:cursor', {
        by: playerId,
        canvas: String(cursor.canvas).slice(0, 40),
        x: Number(cursor.x) || 0,
        y: Number(cursor.y) || 0,
        color: typeof cursor.color === 'string' ? cursor.color.slice(0, 7) : '#000000',
        gone: !!cursor.gone,
      } satisfies StudioCursor);
    } catch { /* not in a room */ }
  });
}
