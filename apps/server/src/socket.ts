/**
 * Socket.IO wiring: transport ↔ rooms ↔ engines.
 *
 * This layer knows nothing about Cabo rules — it routes opaque game actions
 * to the engine interface and broadcasts the engine's per-player views.
 */

import { RuleZeroEngine } from './rulezeroEngine.js';
import { takeRulezeroSpec } from './gameLab.js';
import type { Server as SocketServer, Socket } from 'socket.io';
import type { RoomManager } from './roomManager.js';
import { Room, RoomError } from './room.js';
import type { ChatMessage, JoinResult, RoomLobbyState, MediaMemberInfo } from './protocol.js';
import { MediaMesh } from './media.js';
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
  const persistRoom = (room: Room): Promise<void> => rooms.persistNow(room);
  const lobbyOf = (room: Room, forPlayerId?: string): RoomLobbyState => {
    const state = room.lobbyState();
    state.spectator = !!forPlayerId && room.spectators.has(forPlayerId);
    if (forPlayerId) {
      state.players = state.players.map((p) => ({ ...p, isYou: p.id === forPlayerId }));
      if (forPlayerId === room.hostId) state.aiThoughts = room.aiThoughts;
    }
    return state;
  };

  const broadcastLobby = (room: Room): void => {
    // Send each player a lobby view marked with their OWN player id, so the
    // host sees the Start button and everyone sees their own name highlighted.
    for (const p of room.participants) {
      for (const sid of p.sockets) {
        io.to(sid).emit('room:state', lobbyOf(room, p.id));
      }
    }
  };

  const broadcastGame = async (room: Room): Promise<void> => {
    if (!room.engine) return;
    if (room.engine instanceof RuleZeroEngine) {
      // Service-backed views are async — fan out per player.
      for (const p of room.participants) {
        await room
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
    for (const p of room.participants) {
      const view = room.gameView(p.id);
      if (!view) continue;
      for (const sid of p.sockets) {
        io.to(sid).emit('game:view', view);
      }
    }
  };

  // AI seats are driven here: the loop re-enters through afterChange.
  // Peer-to-peer voice/video mesh membership. The server only tracks who is
  // connected and relays signaling — media never touches the server.
  const mediaMesh = new MediaMesh();
  const broadcastMediaPeers = (roomId: string): void => {
    const members = mediaMesh.members(roomId);
    const peers: MediaMemberInfo[] = members.map(({ playerId, mic, cam }) => ({ playerId, mic, cam }));
    for (const member of members) {
      for (const sid of member.socketIds) io.to(sid).emit('media:peers', { peers });
    }
  };

  const agents = new AgentLoops(io, {
    afterChange: (room) => afterChange(room),
    aiThought: (room, thought) => {
      const host = room.hostId ? room.players.get(room.hostId) : undefined;
      if (!host) return;
      for (const sid of host.sockets) io.to(sid).emit('room:ai_thought', thought);
    },
  });
  const afterChange = async (room: Room): Promise<void> => {
    await persistRoom(room);
    broadcastLobby(room);
    await broadcastGame(room);
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
      if (!data.playerId || !room.participant(data.playerId)) throw new RoomError('not in room');
      return { room, playerId: data.playerId };
    };

    // -----------------------------------------------------------------
    // Room lifecycle
    // -----------------------------------------------------------------

    socket.on('room:create', async ({ name, rulezeroSpecToken, autoAi, watch, checkpointId }, ack) => {
      try {
        const room = rooms.createRoom();
        room.notifyHook = () => afterChange(room);
        if (rulezeroSpecToken) {
          const spec = takeRulezeroSpec(rulezeroSpecToken);
          if (!spec) { rooms.delete(room.id, "invalid launch"); throw new RoomError("Launch expired; try again"); }
          room.rulezeroSpec = spec;
          room.gameId = "rulezero";
        }
        const { player } = watch ? room.addSpectator(name) : room.addPlayer(name);
        if (watch) { room.hostId = player.id; socket.join(room.id + ':spectators'); }
        else socket.join(room.id + ':players');
        if (checkpointId) {
          if (typeof checkpointId !== 'string' || !/^[a-f0-9]{64}$/.test(checkpointId)) throw new RoomError('Invalid checkpoint');
          room.aiPolicies = ['checkpoint:' + checkpointId, 'random'];
        }
        data.roomId = room.id;
        data.playerId = player.id;
        room.attachSocket(player.id, socket.id);
        socket.join(room.id);
        system(room, `${player.name} created the room`);
        if (autoAi && rulezeroSpecToken) {
          while (room.players.size < room.requiredPlayers) room.addAiPlayer(player.id, "balanced");
          room.startGame(player.id);
          await room.whenReady();
        }
        await persistRoom(room);
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

    socket.on('room:join', ({ roomId, name, playerToken, spectator }, ack) => {
      try {
        const room = rooms.getRoom(roomId);
        if (!room) throw new RoomError('room not found');
        const { player, reconnected } = spectator ? room.addSpectator(name, playerToken) : room.addPlayer(name, playerToken);
        if (room.spectators.has(player.id)) socket.join(room.id + ":spectators");
        else socket.join(room.id + ':players');
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

    socket.on('room:set_spectating', ({ enabled }) => {
      const { room, playerId } = requireRoom();
      if (playerId !== room.hostId) return;
      room.allowSpectators = enabled === true;
      if (!room.allowSpectators) {
        for (const p of room.spectators.values()) for (const sid of p.sockets) {
          io.to(sid).emit('room:closed', { reason: 'Spectating disabled by host' });
          const viewer = io.sockets.sockets.get(sid);
          viewer?.leave(room.id); viewer?.leave(room.id + ':spectators');
        }
        room.spectators.clear();
      }
      afterChange(room);
    });
    socket.on('room:move_seat', ({ playerId: target, seat }, ack) => {
      try { const { room, playerId } = requireRoom(); room.moveSeat(playerId, target, seat); afterChange(room); ack?.({ ok: true }); }
      catch (e) { ack?.(fail(e)); }
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
          // Starting a room also needs to wake the AI pump. Keeping this on
          // the shared change path prevents a freshly dealt AI game from
          // waiting forever for its first timer.
          afterChange(room);
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

    socket.on('room:end_game', (_, ack) => {
      try {
        const { room, playerId } = requireRoom();
        room.endGame(playerId);
        ack?.({ ok: true });
        afterChange(room);
      } catch (err) {
        ack?.({ ok: false, error: msg(err) });
        log.warn('end_game_failed', { error: msg(err) });
      }
    });

    socket.on('room:kick_live', ({ playerId: targetId }, ack) => {
      try {
        const { room, playerId } = requireRoom();
        room.kickInGame(playerId, targetId);
        ack?.({ ok: true });
        // The seat went to the AI: its live human leaves the media mesh.
        if (mediaMesh.removeMember(room.id, targetId)) broadcastMediaPeers(room.id);
        afterChange(room);
      } catch (err) {
        ack?.({ ok: false, error: msg(err) });
        log.warn('kick_live_failed', { error: msg(err) });
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

    socket.on('room:set_series_target', ({ target }: { target: number | null }) => {
      try {
        const { room, playerId } = requireRoom();
        room.setSeriesTarget(playerId, target ?? null);
        const last = room.chat[room.chat.length - 1]!;
        io.to(room.id).emit('room:chat', last);
        broadcastLobby(room);
        persistRoom(room);
      } catch (err) {
        log.warn('set_series_target_failed', { error: msg(err) });
      }
    });

    socket.on('room:set_ai_debug', ({ enabled }) => {
      try {
        const { room, playerId } = requireRoom();
        room.setAiDebug(playerId, !!enabled);
        broadcastLobby(room);
        persistRoom(room);
        // Enabling the inspector during a turn must wake the agent loop. This
        // makes the next pending decision emit its live `thinking` record
        // instead of waiting for an unrelated room mutation.
        agents.notify(room);
      } catch (err) {
        log.warn('set_ai_debug_failed', { error: msg(err) });
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
        // A kicked player leaves the media mesh with the room.
        if (mediaMesh.removeMember(room.id, targetId)) broadcastMediaPeers(room.id);
        const kickedSockets = [...target.sockets];
        for (const sid of kickedSockets) {
          const s = io.sockets.sockets.get(sid);
          if (s) {
            (s.data as SocketData).roomId = undefined;
            (s.data as SocketData).playerId = undefined;
            s.leave(room.id);
            s.leave(room.id + ':players');
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
    socket.on('game:sync', async (clientRevision: unknown) => {
      try {
        const { room, playerId } = requireRoom();
        if (!room.engine) return;
        const view = await room.gameViewAsync(playerId);
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
    socket.on('room:restart_game', async (_payload, ack) => {
      try {
        const { room, playerId } = requireRoom();
        await room.runCommand(async () => {
          room.restartGame(playerId);
          await room.whenReady();
          await persistRoom(room);
        });
        ack?.({ ok: true });
        const last = room.chat[room.chat.length - 1]!;
        io.to(room.id).emit('room:chat', last);
        afterChange(room);
      } catch (err) {
        ack?.(fail(err));
      }
    });

    socket.on('room:start_game', async (_payload, ack) => {
      try {
        const { room, playerId } = requireRoom();
        await room.runCommand(async () => {
          room.startGame(playerId);
          await room.whenReady();
          await persistRoom(room);
        });
        ack?.({ ok: true });
        const last = room.chat[room.chat.length - 1]!;
        io.to(room.id).emit('room:chat', last);
        // This is the important first notification for AI-vs-human rooms:
        // afterChange broadcasts the deal and schedules the bot turn.
        afterChange(room);
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

    socket.on('room:play_again', async (_payload, ack) => {
      try {
        const { room, playerId } = requireRoom();
        await room.runCommand(async () => {
          room.playAgain(playerId);
          await room.whenReady();
          await persistRoom(room);
        });
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
        if (chatMsg) io.to(room.spectators.has(playerId) ? room.id + ':spectators' : room.id + ':players').emit('room:chat', chatMsg);
      } catch {
        /* ignore */
      }
    });

    socket.on('room:emote', ({ emote }) => {
      try {
        const { room, playerId } = requireRoom();
        if (room.spectators.has(playerId)) return;
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

    socket.on('game:action', async ({ action }, ack) => {
      try {
        const { room, playerId } = requireRoom();
        await room.runCommand(async () => {
          await room.applyGameAction(playerId, action);
          await afterChange(room);
        });
        ack?.({ ok: true });
      } catch (err) {
        ack?.(fail(err));
      }
    });

    // -----------------------------------------------------------------
    // Peer-to-peer media mesh (voice + webcam, signaling relay only)
    // -----------------------------------------------------------------

    const leaveMedia = (): void => {
      if (!data.roomId || !data.playerId) return;
      const fullyLeft = mediaMesh.leaveSocket(data.roomId, data.playerId, socket.id);
      mediaMesh.forgetSocket(socket.id);
      if (fullyLeft) broadcastMediaPeers(data.roomId);
    };

    socket.on('media:join', ({ mic, cam }) => {
      try {
        const { room, playerId } = requireRoom();
        // Seated players only: spectators watch the table but stay off the
        // mesh (one less live-media moderation surface).
        if (!room.players.has(playerId)) throw new RoomError('spectators cannot join the media mesh');
        mediaMesh.join(room.id, playerId, socket.id, { mic: !!mic, cam: !!cam });
        broadcastMediaPeers(room.id);
      } catch (err) {
        log.warn('media_join_failed', { error: msg(err) });
      }
    });

    socket.on('media:signal', ({ to, data: signal }) => {
      try {
        const { room, playerId } = requireRoom();
        if (typeof to !== 'string' || signal == null) return;
        // Token bucket per socket: runaway clients cannot flood relays.
        if (!mediaMesh.allowSignal(socket.id)) return;
        const member = mediaMesh.members(room.id).find((m) => m.playerId === to);
        if (!member) return;
        for (const sid of member.socketIds) io.to(sid).emit('media:signal', { from: playerId, data: signal });
      } catch (err) {
        log.warn('media_signal_failed', { error: msg(err) });
      }
    });

    socket.on('media:update', ({ mic, cam }) => {
      try {
        const { room, playerId } = requireRoom();
        mediaMesh.update(room.id, playerId, { mic: !!mic, cam: !!cam });
        broadcastMediaPeers(room.id);
      } catch {
        /* ignore */
      }
    });

    socket.on('media:leave', () => {
      leaveMedia();
    });

    // -----------------------------------------------------------------
    // Disconnect
    // -----------------------------------------------------------------

    socket.on('room:leave', () => {
      try {
        const { room, playerId } = requireRoom();
        leaveMedia();
        mediaMesh.removeMember(room.id, playerId);
        room.detachSocket(playerId, socket.id);
        room.removePlayer(playerId);
        socket.leave(room.id + ':players');
        socket.leave(room.id + ':spectators');
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
        leaveMedia();
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
          const p = now.participant(playerId);
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
