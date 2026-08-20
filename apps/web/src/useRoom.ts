/**
 * React hook binding the socket lifecycle to room state: connection, lobby
 * state, chat, filtered game view, and reconnection. All gameplay data comes
 * from the server — the client never fabricates authoritative state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { GameAction } from '@shared/game.js';
import type { CaboPlayerView } from '@cabo/views.js';
import type { ChatMessage, JoinResult, RoomLobbyState } from './server-protocol.js';
import { playSound } from './sound.js';

/** Derive sound cues from view transitions by comparing event logs. */
function playSoundsFor(prev: CaboPlayerView, next: CaboPlayerView): void {
  const seen = new Set(prev.events.map((e) => e.seq));
  for (const ev of next.events) {
    if (seen.has(ev.seq)) continue;
    switch (ev.type) {
      case 'CARD_DRAWN':
        playSound('draw');
        break;
      case 'CARDS_DEALT':
        playSound('deal');
        break;
      case 'CARD_DISCARDED':
      case 'CARD_REPLACED':
        playSound('discard');
        break;
      case 'CARD_FLUSHED':
        playSound('flush');
        break;
      case 'POWER_RESOLVED':
        playSound('flip');
        break;
      case 'CABO_CALLED':
        playSound('cabo');
        break;
      case 'ROUND_REVEALED':
        playSound('reveal');
        break;
      case 'INITIAL_PEEKED':
        playSound('flip');
        break;
    }
  }
}
import {
  loadSession,
  saveSession,
  clearSession,
  loadName,
  saveName,
} from './session.js';

export type ConnStatus = 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface RoomApi {
  socket: Socket | null;
  status: ConnStatus;
  roomId: string | null;
  myPlayerId: string | null;
  lobby: RoomLobbyState | null;
  view: CaboPlayerView | null;
  chat: ChatMessage[];
  unreadChat: number;
  markChatRead: () => void;
  joinError: string | null;
  createRoom: (name: string) => Promise<JoinResult>;
  joinRoom: (roomId: string, name?: string) => Promise<JoinResult>;
  setName: (name: string) => void;
  setReady: (ready: boolean) => void;
  selectGame: (gameId: string) => void;
  startGame: () => Promise<{ ok: boolean; error?: string }>;
  sendChat: (text: string) => void;
  sendAction: (action: Omit<GameAction, 'playerId'>) => Promise<{ ok: boolean; error?: string }>;
  returnToLobby: () => void;
  leaveRoom: () => void;
}

export function useRoom(): RoomApi {
  const socketRef = useRef<Socket | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [lobby, setLobby] = useState<RoomLobbyState | null>(null);
  const [view, setView] = useState<CaboPlayerView | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [joinError, setJoinError] = useState<string | null>(null);
  const chatOpenRef = useRef(false);

  useEffect(() => {
    const s = io({ transports: ['websocket', 'polling'] });
    socketRef.current = s;
    setSocket(s);
    s.on('connect', () => setStatus('connected'));
    s.on('disconnect', () => setStatus('reconnecting'));
    s.on('connect_error', () => setStatus((prev) => (prev === 'error' ? prev : 'reconnecting')));
    return () => {
      s.removeAllListeners();
      s.close();
    };
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onState = (state: RoomLobbyState) => setLobby(state);
    const onChat = (msg: ChatMessage) => {
      setChat((prev) => {
        const next = prev.filter((m) => m.id !== msg.id);
        next.push(msg);
        return next.slice(-200);
      });
      if (msg.playerId === null && /joined|reconnected/.test(msg.text)) playSound('join');
      if (!chatOpenRef.current && msg.playerId !== null) setUnread((n) => n + 1);
    };
    const onView = (v: CaboPlayerView) => {
      setView((prev) => {
        if (prev && prev !== v) playSoundsFor(prev, v);
        return v;
      });
    };
    socket.on('room:state', onState);
    socket.on('room:chat', onChat);
    socket.on('game:view', onView);
    socket.on('room:closed', ({ reason }) => setJoinError(`Room closed: ${reason}`));
    return () => {
      socket.off('room:state', onState);
      socket.off('room:chat', onChat);
      socket.off('game:view', onView);
      socket.off('room:closed');
    };
  }, [socket]);

  const persist = useCallback((res: JoinResult) => {
    if (res.ok && res.roomId && res.playerId && res.playerToken) {
      saveSession({
        roomId: res.roomId,
        playerId: res.playerId,
        playerToken: res.playerToken,
        name: loadName(),
      });
      setRoomId(res.roomId);
      setMyPlayerId(res.playerId);
    }
    return res;
  }, []);

  const createRoom = useCallback(
    (name: string) =>
      new Promise<JoinResult>((resolve) => {
        saveName(name);
        socketRef.current?.emit('room:create', { name }, (res: JoinResult) => {
          if (res.ok) persist(res);
          else setJoinError(res.error ?? 'failed to create room');
          resolve(res);
        });
      }),
    [persist],
  );

  const joinRoom = useCallback(
    (targetRoomId: string, name?: string) =>
      new Promise<JoinResult>((resolve) => {
        const stored = loadSession(targetRoomId);
        const payload = {
          roomId: targetRoomId,
          name: name ?? stored?.name ?? (loadName() || undefined),
          playerToken: stored?.playerToken,
        };
        socketRef.current?.emit('room:join', payload, (res: JoinResult) => {
          if (res.ok) persist(res);
          else setJoinError(res.error ?? 'failed to join room');
          resolve(res);
        });
      }),
    [persist],
  );

  const api: RoomApi = useMemo(
    () => ({
      socket,
      status,
      roomId,
      myPlayerId,
      lobby,
      view,
      chat,
      unreadChat: unread,
      markChatRead: () => {
        chatOpenRef.current = true;
        setUnread(0);
      },
      joinError,
      createRoom,
      joinRoom,
      setName: (name: string) => {
        saveName(name);
        socketRef.current?.emit('room:set_name', { name });
      },
      setReady: (ready: boolean) => socketRef.current?.emit('room:set_ready', { ready }),
      selectGame: (gameId: string) => socketRef.current?.emit('room:select_game', { gameId }),
      startGame: () =>
        new Promise((resolve) => {
          socketRef.current?.emit('room:start_game', {}, resolve);
        }),
      sendChat: (text: string) => socketRef.current?.emit('room:chat', { text }),
      sendAction: (action) =>
        new Promise((resolve) => {
          socketRef.current?.emit('game:action', { action }, resolve);
        }),
      returnToLobby: () => socketRef.current?.emit('room:return_to_lobby'),
      leaveRoom: () => {
        if (roomId) clearSession(roomId);
        socketRef.current?.emit('room:leave');
        setLobby(null);
        setView(null);
        setChat([]);
        setRoomId(null);
        setMyPlayerId(null);
      },
    }),
    [socket, status, roomId, myPlayerId, lobby, view, chat, unread, joinError, createRoom, joinRoom],
  );

  return api;
}
