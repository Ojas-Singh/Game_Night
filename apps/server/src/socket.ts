/**
 * Socket.IO wiring: transport ↔ rooms ↔ engines.
 *
 * This layer knows nothing about Cabo rules — it routes opaque game actions
 * to the engine interface and broadcasts the engine's per-player views.
 */

import type { Server as SocketServer, Socket } from 'socket.io';
import type { RoomManager } from './roomManager.js';
import { Room, RoomError } from './room.js';
import type { ChatMessage, JoinResult, RoomLobbyState } from './protocol.js';
import { log } from './log.js';

interface SocketData {
  roomId?: string;
  playerId?: string;
}

/** Grace window before a dropped socket marks a player disconnected. */
const PRESENCE_DEBOUNCE_MS = 5_000;

export function registerSocketHandlers(io: SocketServer, rooms: RoomManager): void {
  const persistRoom = (room: Room): void => rooms.persistNow(room);
  const lobbyOf = (room: Room, forPlayerId?: string): RoomLobbyState => {
    const state = room.lobbyState();
    if (forPlayerId) {
      state.players = state.players.map((p) => ({ ...p, isYou: p.id === forPlayerId }));
    }
    return state;
  };

  const broadcastLobby = (room: Room): void => {
    // Send each player a lobby view marked with their OWN player id, so the
    // host sees the Start button and everyone sees their own name highlighted.
    for (const p of room.players.values()) {
      for (const sid of p.sockets) {
        io.to(sid).emit('room:state', lobbyOf(room, p.id));
      }
    }
  };

  const broadcastGame = (room: Room): void => {
    if (!room.engine) return;
    for (const p of room.players.values()) {
      const view = room.gameView(p.id);
      if (!view) continue;
      for (const sid of p.sockets) {
        io.to(sid).emit('game:view', view);
      }
    }
  };

  const syncPlayer = (room: Room, playerId: string): void => {
    broadcastLobby(room);
    broadcastGame(room);
    persistRoom(room);
  };

  const system = (room: Room, text: string): void => {
    // room.system() only records; re-broadcast via chat path.
    room.system(text);
    const msg = room.chat[room.chat.length - 1]!;
    io.to(room.id).emit('room:chat', msg);
  };

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;
    log.debug('socket_connected', { socketId: socket.id });

    const requireRoom = (): { room: Room; playerId: string } => {
      const room = data.roomId ? rooms.getRoom(data.roomId) : undefined;
      if (!room) throw new RoomError('room not found');
      if (!data.playerId || !room.players.has(data.playerId)) throw new RoomError('not in room');
      return { room, playerId: data.playerId };
    };

    // -----------------------------------------------------------------
    // Room lifecycle
    // -----------------------------------------------------------------

    socket.on('room:create', ({ name }, ack) => {
      try {
        const room = rooms.createRoom();
        const { player } = room.addPlayer(name);
        data.roomId = room.id;
        data.playerId = player.id;
        room.attachSocket(player.id, socket.id);
        socket.join(room.id);
        system(room, `${player.name} created the room`);
        ack({
          ok: true,
          roomId: room.id,
          playerId: player.id,
          playerToken: player.token,
        } satisfies JoinResult);
        syncPlayer(room, player.id);
      } catch (err) {
        ack(fail(err));
      }
    });

    socket.on('room:join', ({ roomId, name, playerToken }, ack) => {
      try {
        const room = rooms.getRoom(roomId);
        if (!room) throw new RoomError('room not found');
        const { player, reconnected } = room.addPlayer(name, playerToken);
        data.roomId = room.id;
        data.playerId = player.id;
        room.attachSocket(player.id, socket.id);
        socket.join(room.id);
        log.info(reconnected ? 'reconnect' : 'join', { roomId: room.id, playerId: player.id });
        if (reconnected) {
          const msg = room.chat[room.chat.length - 1]!;
          socket.emit('room:chat', msg);
        } else {
          const msg = room.chat[room.chat.length - 1]!;
          io.to(room.id).emit('room:chat', msg);
        }
        ack({
          ok: true,
          roomId: room.id,
          playerId: player.id,
          playerToken: player.token,
        } satisfies JoinResult);
        syncPlayer(room, player.id);
      } catch (err) {
        ack(fail(err));
      }
    });

    socket.on('room:set_name', ({ name }) => {
      try {
        const { room, playerId } = requireRoom();
        const before = room.players.get(playerId)!.name;
        room.setName(playerId, name);
        const last = room.chat[room.chat.length - 1]!;
        if (last.playerId === null && last.text.includes(before)) {
          io.to(room.id).emit('room:chat', last);
        }
        broadcastLobby(room);
        if (room.engine) broadcastGame(room);
        persistRoom(room);
      } catch (err) {
        log.warn('set_name_failed', { error: msg(err) });
      }
    });

    socket.on('room:set_ready', ({ ready }) => {
      try {
        const { room, playerId } = requireRoom();
        room.setReady(playerId, ready);
        broadcastLobby(room);
      } catch {
        /* ignore */
      }
    });

    socket.on('room:select_game', ({ gameId }) => {
      try {
        const { room, playerId } = requireRoom();
        room.selectGame(playerId, gameId);
        const last = room.chat[room.chat.length - 1]!;
        io.to(room.id).emit('room:chat', last);
        broadcastLobby(room);
      } catch (err) {
        log.warn('select_game_failed', { error: msg(err) });
      }
    });

    socket.on('room:set_swap_others', ({ enabled }) => {
      try {
        const { room, playerId } = requireRoom();
        room.setSwapOthers(playerId, !!enabled);
        const last = room.chat[room.chat.length - 1]!;
        io.to(room.id).emit('room:chat', last);
        broadcastLobby(room);
        persistRoom(room);
      } catch (err) {
        log.warn('set_swap_others_failed', { error: msg(err) });
      }
    });

    socket.on('room:set_test_mode', ({ enabled }) => {
      try {
        const { room, playerId } = requireRoom();
        room.setTestMode(playerId, !!enabled);
        const last = room.chat[room.chat.length - 1]!;
        io.to(room.id).emit('room:chat', last);
        broadcastLobby(room);
        // Refresh every player's game view so Test Mode takes effect at once.
        broadcastGame(room);
        persistRoom(room);
      } catch (err) {
        log.warn('set_test_mode_failed', { error: msg(err) });
      }
    });

    socket.on('room:start_game', (_payload, ack) => {
      try {
        const { room, playerId } = requireRoom();
        room.startGame(playerId);
        ack?.({ ok: true });
        const last = room.chat[room.chat.length - 1]!;
        io.to(room.id).emit('room:chat', last);
        broadcastLobby(room);
        broadcastGame(room);
        persistRoom(room);
      } catch (err) {
        ack?.(fail(err));
      }
    });

    socket.on('room:return_to_lobby', () => {
      try {
        const { room, playerId } = requireRoom();
        room.returnToLobby(playerId);
        broadcastLobby(room);
        persistRoom(room);
      } catch {
        /* ignore */
      }
    });

    socket.on('room:play_again', (_payload, ack) => {
      try {
        const { room, playerId } = requireRoom();
        room.playAgain(playerId);
        ack?.({ ok: true });
        const last = room.chat[room.chat.length - 1]!;
        io.to(room.id).emit('room:chat', last);
        broadcastLobby(room);
        broadcastGame(room);
        persistRoom(room);
      } catch (err) {
        ack?.(fail(err));
      }
    });

    // -----------------------------------------------------------------
    // Chat
    // -----------------------------------------------------------------

    socket.on('room:chat', ({ text }) => {
      try {
        const { room, playerId } = requireRoom();
        const chatMsg = room.playerChat(playerId, text);
        if (chatMsg) io.to(room.id).emit('room:chat', chatMsg);
      } catch {
        /* ignore */
      }
    });

    socket.on('room:emote', ({ emote }) => {
      try {
        const { room, playerId } = requireRoom();
        const clean = typeof emote === 'string' ? emote.slice(0, 8) : '';
        if (!clean) return;
        io.to(room.id).emit('room:emote', {
          playerId,
          emote: clean,
          timestamp: new Date().toISOString(),
        });
      } catch {
        /* ignore */
      }
    });

    // -----------------------------------------------------------------
    // Gameplay — opaque envelope to the engine
    // -----------------------------------------------------------------

    socket.on('game:action', ({ action }, ack) => {
      try {
        const { room, playerId } = requireRoom();
        room.handleGameAction(playerId, action);
        ack?.({ ok: true });
        broadcastGame(room);
        persistRoom(room);
      } catch (err) {
        ack?.(fail(err));
      }
    });

    // -----------------------------------------------------------------
    // Disconnect
    // -----------------------------------------------------------------

    socket.on('room:leave', () => {
      try {
        const { room, playerId } = requireRoom();
        room.detachSocket(playerId, socket.id);
        room.removePlayer(playerId);
        const last = room.chat[room.chat.length - 1]!;
        io.to(room.id).emit('room:chat', last);
        if (room.players.size === 0) {
          room.closed = true;
          rooms.delete(room.id, 'empty');
        } else {
          broadcastLobby(room);
        }
      } catch {
        /* ignore */
      }
      data.roomId = undefined;
      data.playerId = undefined;
    });

    socket.on('disconnect', () => {
      log.debug('socket_disconnected', { socketId: socket.id });
      try {
        const roomId = data.roomId;
        const playerId = data.playerId;
        if (!roomId || !playerId) return;
        const room = rooms.getRoom(roomId);
        if (!room) return;
        room.detachSocket(playerId, socket.id);
        // Presence debounce: only mark the player disconnected if they still
        // have no sockets after a short grace window, so a transient blip or
        // a quick transport reconnect never flips a seat to "reconnecting".
        setTimeout(() => {
          const now = rooms.getRoom(roomId);
          if (!now) return;
          const p = now.players.get(playerId);
          if (!p) return;
          if (p.sockets.size > 0) return; // already back
          now.markDisconnected(playerId);
          const last = now.chat[now.chat.length - 1]!;
          io.to(now.id).emit('room:chat', last);
          broadcastLobby(now);
        }, PRESENCE_DEBOUNCE_MS);
      } catch (err) {
        log.error('disconnect_handler_error', { error: msg(err) });
      }
    });
  });

  function fail(err: unknown): JoinResult & { ok: false } {
    return { ok: false, error: err instanceof RoomError ? err.message : 'internal error' };
  }

  function msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
