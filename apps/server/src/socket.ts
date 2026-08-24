/**
 * Socket.IO wiring: transport ↔ rooms ↔ engines.
 *
 * This layer knows nothing about Cabo rules — it routes opaque game actions
 * to the engine interface and broadcasts the engine's per-player views.
 */

import { RuleZeroEngine } from './rulezeroEngine.js';
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
import { AgentLoops } from './agents/loop.js';

const PRESENCE_DEBOUNCE_MS = 5_000;

export function registerSocketHandlers(io: SocketServer, rooms: RoomManager): void {
  // eslint note: AgentLoops imported statically below the io type import.
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
    if (room.engine instanceof RuleZeroEngine) {
      // Service-backed views are async — fan out per player.
      for (const p of room.players.values()) {
        void room
          .gameViewAsync(p.id)
          .then((view) => {
            if (!view) return;
            for (const sid of p.sockets) io.to(sid).emit('game:view', view);
          })
          .catch((err) =>
            console.error('[rulezero] broadcast failed:', err),
          );
      }
      return;
    }
    for (const p of room.players.values()) {
      const view = room.gameView(p.id);
      if (!view) continue;
      for (const sid of p.sockets) {
        io.to(sid).emit('game:view', view);
      }
    }
  };

  // AI seats are driven here: the loop re-enters through afterChange.
  const agents = new AgentLoops(io, { afterChange: (room) => afterChange(room) });
  const afterChange = (room: Room): void => {
    broadcastLobby(room);
    broadcastGame(room);
    persistRoom(room);
    agents.notify(room);
  };
  const syncPlayer = (room: Room, playerId: string): void => {
    afterChange(room);
    void playerId;
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

    socket.on('room:set_avatar', ({ avatar }) => {
      try {
        const { room, playerId } = requireRoom();
        room.setAvatar(playerId, avatar);
        broadcastLobby(room);
        persistRoom(room);
      } catch {
        /* invalid avatar — ignored */
      }
    });

    socket.on('room:set_ready', ({ ready }) => {
      try {
        const { room, playerId } = requireRoom();
        room.setReady(playerId, ready);
        broadcastLobby(room);
        // Auto-start: once every connected player has clicked ready (and the
        // room is big enough), the game begins on its own.
        const seated = [...room.players.values()].filter((p) => p.connected);
        if (!room.engine && seated.length >= 2 && seated.every((p) => p.ready) && room.hostId) {
          room.startGame(room.hostId);
          const last = room.chat[room.chat.length - 1]!;
          io.to(room.id).emit('room:chat', last);
          broadcastLobby(room);
          broadcastGame(room);
          persistRoom(room);
        }
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

    // Host kicks a player from the lobby: the target is removed, told why,
    // and fully detached from the socket room so they cannot act or rejoin
    // silently via the reconnect path.
    socket.on('room:kick', ({ playerId: targetId }, ack) => {
      try {
        const { room, playerId } = requireRoom();
        const target = room.players.get(targetId);
        if (!target) throw new RoomError('not in room');
        room.kickPlayer(playerId, targetId);
        ack?.({ ok: true });
        const kickedSockets = [...target.sockets];
        for (const sid of kickedSockets) {
          const s = io.sockets.sockets.get(sid);
          if (s) {
            (s.data as SocketData).roomId = undefined;
            (s.data as SocketData).playerId = undefined;
            s.leave(room.id);
          }
          io.to(sid).emit('room:closed', { reason: 'kicked by the host' });
        }
        const last = room.chat[room.chat.length - 1]!;
        io.to(room.id).emit('room:chat', last);
        broadcastLobby(room);
        persistRoom(room);
      } catch (err) {
        ack?.(fail(err));
      }
    });

    // Self-healing sync: a client that suspects it fell behind (window focus,
    // periodic check) asks for a fresh view; the server only sends one when
    // the client's revision is stale, so nothing replays unnecessarily.
    socket.on('game:sync', (clientRevision: unknown) => {
      try {
        const { room, playerId } = requireRoom();
        if (!room.engine) return;
        const view = room.gameView(playerId);
        if (!view) return;
        if (
          typeof clientRevision === 'number' &&
          'revision' in view &&
          view.revision <= clientRevision
        )
          return;
        io.to(socket.id).emit('game:view', view);
      } catch {
        /* not in a room */
      }
    });

    // Host restarts the round at any time (fresh deal, scoreboard kept).
    socket.on('room:restart_game', (_payload, ack) => {
      try {
        const { room, playerId } = requireRoom();
        room.restartGame(playerId);
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
        afterChange(room);
      } catch (err) {
        ack?.(fail(err));
      }
    });

    // -----------------------------------------------------------------
    // Chat
    // -----------------------------------------------------------------

    // Host seats an AI player (lobby only). The agent loop drives its turns.
    socket.on('room:add_ai', ({ persona }: { persona?: string }, ack) => {
      try {
        const { room, playerId } = requireRoom();
        const player = room.addAiPlayer(playerId, typeof persona === 'string' ? persona : undefined);
        log.info('ai_added', { roomId: room.id, aiId: player.id, persona: player.persona });
        ack?.({ ok: true as const, playerId: player.id });
        afterChange(room);
      } catch (err) {
        ack?.(fail(err));
      }
    });

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
        afterChange(room);
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
