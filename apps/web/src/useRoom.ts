/**
 * React hook binding the socket lifecycle to room state: connection, lobby
 * state, chat, filtered game view, and reconnection. All gameplay data comes
 * from the server — the client never fabricates authoritative state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { PairOnePlayerView } from '@pairone/views.js';
import type { PairOneAction } from '@pairone/types.js';
import type { AnyGameView, CaboPlayerView } from './server-protocol.js';
import type { ChatMessage, JoinResult, RoomLobbyState } from './server-protocol.js';
import type { CaboAction } from '@cabo/types.js';
import { playSound } from './sound.js';
import { loadAvatar, saveAvatar } from './avatar.js';
import type { Avatar } from './server-protocol.js';

/** Derive sound cues from view transitions by comparing event logs. */
function playSoundsFor(prev: AnyGameView, next: AnyGameView): void {
  if (prev?.gameId === 'rulezero' || next.gameId === 'rulezero') return; // no event log yet
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
      // ---- Pair One ----
      case 'CARD_FLIPPED':
        playSound('flip');
        break;
      case 'PAIR_COLLECTED':
        playSound('match');
        break;
      case 'PAIR_MISSED':
        playSound('miss');
        break;
    }
  }
}

/** Derive card-flight events from the event log delta between two views. */
export function collectFlights(
  prev: AnyGameView,
  next: AnyGameView,
  myPlayerId?: string | null,
  noteDrawn?: (cardId: string) => void,
): CardFlight[] {
  // Card flights are a Cabo-table feature; Pair One animates its own way.
  if (next.gameId !== 'cabo' || prev.gameId !== 'cabo') return [];
  const seen = new Set(prev.events.map((e) => e.seq));
  const out: CardFlight[] = [];
  for (const ev of next.events) {
    if (seen.has(ev.seq)) continue;
    const p = ev.payload as Record<string, unknown> | undefined;
    const rank = typeof p?.rank === 'number' ? p.rank : 0;
    if (ev.type === 'CARD_FLUSHED') {
      out.push({
        id: `${ev.type}-${ev.seq}`,
        seq: ev.seq,
        fromPlayerId: String(p?.sourcePlayerId ?? ev.playerId ?? ''),
        fromCardId: typeof p?.cardId === 'string' ? p.cardId : undefined,
        toDiscard: true,
        rank,
      });
    } else if (ev.type === 'CARD_DISCARDED' || ev.type === 'CARD_REPLACED') {
      out.push({
        id: `${ev.type}-${ev.seq}`,
        seq: ev.seq,
        fromPlayerId: ev.playerId ?? '',
        toDiscard: true,
        rank,
      });
    } else if (ev.type === 'CARD_DRAWN') {
      // The drawn card flies from the deck to the DRAWING player — their seat
      // for opponents, the local draw slot for me (no rank: it's secret).
      const drawer = String(ev.playerId ?? '');
      // Identify the exact NEW card in their hand (diff vs previous view) so
      // the flight lands on that precise slot instead of the hand centre.
      let landedCardId: string | undefined;
      if (drawer !== myPlayerId && prev) {
        const before = new Set(prev.handCardIds?.[drawer] ?? []);
        landedCardId = (next.handCardIds?.[drawer] ?? []).find((id) => !before.has(id));
        if (landedCardId) noteDrawn?.(landedCardId);
      }
      out.push({
        id: `${ev.type}-${ev.seq}`,
        seq: ev.seq,
        fromPlayerId: 'deck',
        toDiscard: false,
        toPlayerId: drawer === myPlayerId ? undefined : drawer,
        toCardId: drawer === myPlayerId ? undefined : landedCardId,
        rank,
      });
    } else if (ev.type === 'POWER_RESOLVED') {
      const pow = String(p?.power ?? '');
      if (pow === 'PEEK_OWN' || pow === 'PEEK_OTHER') {
        // A peek travels as a glowing "eye" from the peeker to the peeked
        // card's seat — everyone sees WHICH card was looked at (not its value).
        out.push({
          id: `${ev.type}-${ev.seq}`,
          seq: ev.seq,
          kind: 'peek',
          fromPlayerId: String(ev.playerId ?? ''),
          toDiscard: false,
          toPlayerId: String(p?.targetPlayerId ?? ev.playerId ?? ''),
          toCardId: typeof p?.cardId === 'string' ? p.cardId : undefined,
          rank: 0,
        });
      }
      // Swaps (BLIND_SWAP) produce NO ghost flights: the REAL
      // cards glide to their new slots via framer layout animation, and both
      // get a brief glow (swapMarks) — one clear movement, no overlay noise.
    } else if (ev.type === 'PENALTY_DRAWN') {
      // A secret penalty card flies from the deck to the penalized player's
      // hand — face-down (no rank in the shared log), so everyone sees the
      // movement but not the value.
      const toPlayerId = String(ev.playerId ?? '');
      out.push({
        id: `${ev.type}-${ev.seq}`,
        seq: ev.seq,
        fromPlayerId: 'deck',
        toDiscard: false,
        toPlayerId,
        rank: 0,
      });
    }
  }
  return out;
}
import {
  loadSession,
  saveSession,
  clearSession,
  loadName,
  saveName,
} from './session.js';

export type ConnStatus = 'connecting' | 'connected' | 'reconnecting' | 'error';

/** How long a freshly peeked card stays face-up before flipping back down. */
const PEEK_FLASH_MS = 3200;
/** The STARTING peek (your bottom two cards) stays up much longer — that's
 *  the memorize-your-hand moment of the whole game. */
const START_FLASH_MS = 10_000;
/** How long the "someone peeked here" eye badge stays visible. */
const PEEK_MARK_MS = 6000;

/** A Cabo action without playerId, preserving discriminated-union narrowing. */
type ClientCaboAction = {
  [K in CaboAction['type']]: Omit<Extract<CaboAction, { type: K }>, 'playerId'>;
}[CaboAction['type']];

/** A Pair One action without playerId. */
type ClientPairOneAction = Omit<PairOneAction, 'playerId'>;

/** Any game action the client may send (playerId is stamped by the server). */
export type ClientGameAction = ClientCaboAction | ClientPairOneAction;

/** A card visually flying across the table so everyone sees where it went. */
export interface CardFlight {
  id: string;
  seq: number;
  /** Source seat: a player id, or 'deck'. */
  fromPlayerId: string | 'deck';
  /** Destination: the discard pile, or (no toPlayerId) the local draw slot. */
  toDiscard: boolean;
  /** When set, the flight lands in this player's hand (e.g. a secret penalty). */
  toPlayerId?: string;
  rank: number;
  /** 'peek' renders a glowing eye instead of a card (a look, not a move). */
  kind?: 'card' | 'peek';
  /** Exact source card element (measured by data-card-id) when known. */
  fromCardId?: string;
  /** Exact destination card element when known (e.g. the peeked card). */
  toCardId?: string;
}

export interface RoomApi {
  socket: Socket | null;
  status: ConnStatus;
  roomId: string | null;
  myPlayerId: string | null;
  lobby: RoomLobbyState | null;
  /** Filtered game view for whichever game is running (discriminated by gameId). */
  view: AnyGameView | null;
  chat: ChatMessage[];
  unreadChat: number;
  /** Cards currently in their reveal window (face-up): { at, ms }. */
  peekFlash: Record<string, { at: number; ms: number }>;
  /** Cards just drawn by ANOTHER player — golden landing shimmer. */
  drawFlash: Record<string, number>;
  /** Recent card movements to animate as flying cards (source → destination). */
  flights: CardFlight[];
  /** Most recent emote per player: playerId → { emote, at }. */
  emotes: Record<string, { emote: string; at: number }>;
  /** Recently peeked cards: cardId → { byPlayerId, at } — everyone sees
   *  WHICH card was peeked (a decaying eye badge), never its value. */
  peekMarks: Record<string, { byPlayerId: string; at: number }>;
  /** Just-swapped cards: cardId → at (brief glow while gliding). */
  swapMarks: Record<string, number>;
  /** Recent swaps: the two card ids that exchanged places (for the ⇄ connector). */
  swapPairs: Array<{ id: string; cardA: string; cardB: string; at: number }>;
  /** Fresh Cabo call: callerId + client time — drives the big announcement. */
  caboAnnounce: { callerId: string; at: number; name: string } | null;
  sendEmote: (emote: string) => void;
  markChatRead: () => void;
  joinError: string | null;
  createRoom: (
    name: string,
    rulezeroSpecToken?: string,
    autoAi?: boolean,
  ) => Promise<JoinResult>;
  joinRoom: (roomId: string, name?: string) => Promise<JoinResult>;
  setName: (name: string) => void;
  /** Customize my avatar (persisted locally; broadcast to the room). */
  setAvatar: (avatar: Avatar) => void;
  setReady: (ready: boolean) => void;
  selectGame: (gameId: string) => void;
  /** Test Mode: the server reveals every card to everyone (debug/test aid). */
  testMode: boolean;
  setTestMode: (enabled: boolean) => void;
  /** Host aborts the running game; everyone returns to the lobby. */
  endGame: () => void;
  /** Host hands a mid-game seat to the autopilot bot. */
  kickLive: (playerId: string) => void;
  startGame: () => Promise<{ ok: boolean; error?: string }>;
  /** Host-only: remove a player from the lobby. */
  kickPlayer: (playerId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Host-only: seat an AI player with the given strategy persona. */
  addAiPlayer: (persona: string) => Promise<{ ok: boolean; error?: string }>;
  sendChat: (text: string) => void;
  sendAction: (action: ClientGameAction) => Promise<{ ok: boolean; error?: string }>;
  playAgain: () => Promise<{ ok: boolean; error?: string }>;
  returnToLobby: () => void;
  /** Host-only: redeal the round at any time (scoreboard kept). */
  restartGame: () => Promise<{ ok: boolean; error?: string }>;
  leaveRoom: () => void;
}

export function useRoom(): RoomApi {
  const socketRef = useRef<Socket | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [lobby, setLobby] = useState<RoomLobbyState | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [view, setView] = useState<AnyGameView | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [joinError, setJoinError] = useState<string | null>(null);
  const chatOpenRef = useRef(false);
  /** Room we're attached to — drives automatic re-join on any reconnect. */
  const activeRoomRef = useRef<string | null>(null);
  /** Cards in their reveal window → rendered face-up briefly, then flip down. */
  const [peekFlash, setPeekFlash] = useState<Record<string, { at: number; ms: number }>>({});
  const [drawFlash, setDrawFlash] = useState<Record<string, number>>({});
  /** Latest applied game:view — side effects diff against this OUTSIDE any
   *  React updater (StrictMode re-invokes updaters; impure ones lose updates,
   *  which is why the starting peek used to never flash). */
  const viewRef = useRef<AnyGameView | null>(null);
  /** Emote reactions: playerId → latest { emote, at } (at = client receive time). */
  const [emotes, setEmotes] = useState<Record<string, { emote: string; at: number }>>({});
  /** Recent card movements to animate (pruned automatically over time). */
  const [flights, setFlights] = useState<CardFlight[]>([]);
  /** Recently peeked cards (eye badges that decay). */
  const [peekMarks, setPeekMarks] = useState<Record<string, { byPlayerId: string; at: number }>>({});
  /** Just-swapped cards (brief glow, cleared after the glide). */
  const [swapMarks, setSwapMarks] = useState<Record<string, number>>({});
  /** Recent swap pairs (⇄ connectors between the two slots). */
  const [swapPairs, setSwapPairs] = useState<Array<{ id: string; cardA: string; cardB: string; at: number }>>([]);
  /** Fresh Cabo call → full-screen announcement + page effect. */
  const [caboAnnounce, setCaboAnnounce] = useState<{ callerId: string; at: number; name: string } | null>(null);
  const myIdRef = useRef<string | null>(null);
  myIdRef.current = myPlayerId;

  const flashKnowledge = useCallback((prev: AnyGameView | null, next: AnyGameView): void => {
    if (next.gameId !== 'cabo') return; // cabo-only card-flash machinery
    // prev === null on the FIRST view after (re)join — the starting peek of
    // the bottom two cards arrives that way, so it must flash too (longer:
    // it's the memorize-your-cards moment). Pair One has no private peek:
    // skip the join-time mega-flash; its flips flash via the normal path.
    if (next.gameId !== 'cabo') return;
    if (!prev || prev.gameId !== 'cabo') return;
    const before = new Set(Object.keys(prev.knownCards));
    const ids = new Set(Object.keys((next as CaboPlayerView).knownCards).filter((id) => !before.has(id)));
    // Also re-flash EVERY card a fresh CARD_FLIPPED event reveals, EVEN IF we
    // already knew it. Pair One players flip already-open cards constantly
    // (that's how memory works), and without this such a card would snap back
    // face-down the instant the turn resolved instead of staying up for the
    // shared reveal window.
    const lastSeq = prev.events.length > 0 ? prev.events[prev.events.length - 1]!.seq : 0;
    for (const e of (next as CaboPlayerView).events) {
      if (e.seq <= lastSeq || e.type !== 'CARD_FLIPPED') continue;
      for (const id of (e.payload?.cardIds as string[] | undefined) ?? []) {
        if (id) ids.add(id);
      }
    }
    if (ids.size === 0) return;
    const ms = prev ? PEEK_FLASH_MS : START_FLASH_MS;
    const at = Date.now();
    setPeekFlash((cur) => {
      const updated = { ...cur };
      for (const id of ids) updated[id] = { at, ms };
      return updated;
    });
    // Flip back down after the reveal window.
    setTimeout(() => {
      setPeekFlash((cur) => {
        const nextMap: Record<string, { at: number; ms: number }> = {};
        for (const [id, f] of Object.entries(cur)) {
          if (at - f.at < f.ms - 50) nextMap[id] = f;
        }
        return nextMap;
      });
    }, ms);
  }, []);

  /** Re-flash cards you just peeked, EVEN IF you already knew them — the
   *  7–8 / 9–10 powers are a revision aid, not just discovery. */
  const touchFlash = useCallback((cardIds: string[]): void => {
    if (cardIds.length === 0) return;
    const at = Date.now();
    setPeekFlash((cur) => {
      const updated = { ...cur };
      for (const id of cardIds) updated[id] = { at, ms: PEEK_FLASH_MS };
      return updated;
    });
    setTimeout(() => {
      setPeekFlash((cur) => {
        const nextMap: Record<string, { at: number; ms: number }> = {};
        for (const [id, f] of Object.entries(cur)) {
          if (at - f.at < f.ms - 50) nextMap[id] = f;
        }
        return nextMap;
      });
    }, PEEK_FLASH_MS);
  }, []);

  useEffect(() => {
    const s = io({ transports: ['websocket', 'polling'] });
    socketRef.current = s;
    setSocket(s);
    s.on('connect', () => {
      setStatus('connected');
      // Robust reattachment: if the transport dropped and came back (proxy
      // hiccup, sleep/wake, server restart), silently re-join with our secret
      // token so the seat is restored without any user action.
      const rid = activeRoomRef.current;
      if (rid) {
        const stored = loadSession(rid);
        s.emit(
          'room:join',
          { roomId: rid, playerToken: stored?.playerToken },
          (res: JoinResult) => {
            if (res.ok) persistSession(res);
          },
        );
      }
    });
    s.on('disconnect', () => setStatus('reconnecting'));
    s.on('connect_error', () => setStatus((prev) => (prev === 'error' ? prev : 'reconnecting')));
    return () => {
      s.removeAllListeners();
      s.close();
    };
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onState = (state: RoomLobbyState) => {
      setLobby(state);
      setTestMode(!!state.testMode);
    };
    const onChat = (msg: ChatMessage) => {
      setChat((prev) => {
        const next = prev.filter((m) => m.id !== msg.id);
        next.push(msg);
        return next.slice(-200);
      });
      if (msg.playerId === null && /joined|reconnected/.test(msg.text)) playSound('join');
      if (!chatOpenRef.current && msg.playerId !== null) setUnread((n) => n + 1);
    };
    const onView = (v: AnyGameView) => {
      let prev = viewRef.current;
      if (prev === v) return;
      if (prev && prev.gameId !== v.gameId) prev = null; // game switched: no delta side effects
      viewRef.current = v;
      setView(v);
      // All side effects run here in the socket handler — NEVER inside a
      // state updater (StrictMode re-invokes updaters and drops nested
      // updates, which silently killed the starting-peek flash).
      if (prev) playSoundsFor(prev, v);
      flashKnowledge(prev, v);
      if (!prev || prev.gameId !== 'cabo' || v.gameId !== 'cabo') return;
      // cabo-only flight/eye machinery below
      const fresh = collectFlights(prev, v, myIdRef.current, (cardId) => {
        // Golden landing shimmer when the flight touches down (~flight time).
        setTimeout(() => {
          setDrawFlash((m) => ({ ...m, [cardId]: Date.now() }));
          setTimeout(() => setDrawFlash((m) => {
            if (!(cardId in m)) return m;
            const cp = { ...m }; delete cp[cardId]; return cp;
          }), 1500);
        }, 620);
      });
      if (fresh.length > 0) {
        setFlights((cur) => [...cur, ...fresh].slice(-8));
      }
      // Eye badges: which cards were just peeked (by whom).
      const seen = new Set(prev.events.map((e) => e.seq));
      const now = Date.now();
      const marks: Array<[string, string]> = [];
      const revision: string[] = [];
      for (const ev of v.events) {
        if (seen.has(ev.seq)) continue;
        const p = ev.payload as Record<string, unknown> | undefined;
        if (ev.type === 'POWER_RESOLVED' && (p?.power === 'PEEK_OWN' || p?.power === 'PEEK_OTHER') && typeof p?.cardId === 'string') {
          marks.push([p.cardId, String(ev.playerId ?? '')]);
          // My own peek re-flashes the card even when I already knew it.
          if (String(p?.viewerId ?? '') === myIdRef.current) revision.push(p.cardId);
        }
      }
      if (revision.length > 0) touchFlash(revision);
      // Swaps: glow the two cards that just exchanged places + pair them.
      const swappedIds: string[] = [];
      const newPairs: Array<{ id: string; cardA: string; cardB: string; at: number }> = [];
      for (const ev of v.events) {
        if (seen.has(ev.seq)) continue;
        const p = ev.payload as Record<string, unknown> | undefined;
        if (ev.type === 'POWER_RESOLVED' && p?.power === 'BLIND_SWAP') {
          if (typeof p.ownCardId === 'string') swappedIds.push(p.ownCardId);
          if (typeof p.targetCardId === 'string') swappedIds.push(p.targetCardId);
          if (typeof p.ownCardId === 'string' && typeof p.targetCardId === 'string') {
            newPairs.push({ id: `swap-${ev.seq}`, cardA: p.ownCardId, cardB: p.targetCardId, at: Date.now() });
          }
        }
      }
      if (newPairs.length > 0) {
        playSound('swap');
        setSwapPairs((cur) => [...cur, ...newPairs].slice(-4));
        setTimeout(() => {
          setSwapPairs((cur) => cur.filter((x) => !newPairs.some((n) => n.id === x.id)));
        }, 3200);
      }
      if (swappedIds.length > 0) {
        const at = Date.now();
        setSwapMarks((cur) => {
          const next = { ...cur };
          for (const id of swappedIds) next[id] = at;
          return next;
        });
        setTimeout(() => {
          setSwapMarks((cur) => {
            const kept: typeof cur = {};
            for (const [id, t] of Object.entries(cur)) {
              if (at - t < 2000 - 50) kept[id] = t;
            }
            return kept;
          });
        }, 2000);
      }
      if (marks.length > 0) {
        setPeekMarks((cur) => {
          const nextMarks = { ...cur };
          for (const [cardId, by] of marks) nextMarks[cardId] = { byPlayerId: by, at: now };
          return nextMarks;
        });
        setTimeout(() => {
          setPeekMarks((cur) => {
            const kept: typeof cur = {};
            for (const [id, m] of Object.entries(cur)) {
              if (now - m.at < PEEK_MARK_MS - 50) kept[id] = m;
            }
            return kept;
          });
        }, PEEK_MARK_MS);
      }
    };
    // Self-healing view sync: if an update was ever missed (flaky transport,
    // stale socket), ask the server for a fresh view on focus + periodically.
    const requestSync = () => {
      socketRef.current?.emit(
        'game:sync',
        ((viewRef.current as { revision?: number } | null)?.revision) ?? 0,
      );
    };
    window.addEventListener('focus', requestSync);
    const syncTimer = window.setInterval(requestSync, 12_000);
    socket.on('room:state', onState);
    socket.on('room:chat', onChat);
    socket.on('game:view', onView);
    const onEmote = ({ playerId, emote }: { playerId: string; emote: string }) => {
      setEmotes((prev) => ({ ...prev, [playerId]: { emote, at: Date.now() } }));
    };
    socket.on('room:emote', onEmote);
    socket.on('room:closed', ({ reason }) => {
      // Fully detach: clear the stored session so the reconnect path can't
      // silently re-join a room we were kicked from (or that was deleted).
      const rid = activeRoomRef.current;
      if (rid) clearSession(rid);
      activeRoomRef.current = null;
      setLobby(null);
      setView(null);
      viewRef.current = null;
      setChat([]);
      setRoomId(null);
      setMyPlayerId(null);
      setJoinError(`Room closed: ${reason}`);
    });
    return () => {
      window.removeEventListener('focus', requestSync);
      window.clearInterval(syncTimer);
      socket.off('room:state', onState);
      socket.off('room:chat', onChat);
      socket.off('game:view', onView);
      socket.off('room:emote', onEmote);
      socket.off('room:closed');
    };
  }, [socket]);

  const persistSession = useCallback((res: JoinResult) => {
    if (res.ok && res.roomId && res.playerId && res.playerToken) {
      activeRoomRef.current = res.roomId;
      saveSession({
        roomId: res.roomId,
        playerId: res.playerId,
        playerToken: res.playerToken,
        name: loadName(),
      });
      setRoomId(res.roomId);
      setMyPlayerId(res.playerId);
      // Apply my saved look to the (possibly random) seat avatar right away.
      socketRef.current?.emit('room:set_avatar', { avatar: loadAvatar() });
    }
    return res;
  }, []);

  const createRoom = useCallback(
    (name: string, rulezeroSpecToken?: string, autoAi?: boolean) =>
      new Promise<JoinResult>((resolve) => {
        saveName(name);
        socketRef.current?.emit(
          'room:create',
          rulezeroSpecToken ? { name, rulezeroSpecToken } : { name },
          (res: JoinResult) => {
            if (!res.ok) {
              setJoinError(res.error ?? 'failed to create room');
              resolve(res);
              return;
            }
            persistSession(res);
            if (!rulezeroSpecToken) {
              resolve(res);
              return;
            }
            // Staged RuleZero launch: pin the game, optionally seat an AI,
            // and auto-start so the player lands straight at the table.
            socketRef.current?.emit('room:select_game', { gameId: 'rulezero' });
            if (!autoAi) {
              socketRef.current?.emit('room:start_game', {}, () => resolve(res));
            } else {
              socketRef.current?.emit('room:add_ai', {}, () => {
                socketRef.current?.emit('room:start_game', {}, () => resolve(res));
              });
            }
          },
        );
      }),
    [persistSession],
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
          if (res.ok) persistSession(res);
          else setJoinError(res.error ?? 'failed to join room');
          resolve(res);
        });
      }),
    [persistSession],
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
      peekFlash,
      drawFlash,
      emotes,
      peekMarks,
      swapMarks,
      swapPairs,
      caboAnnounce,
      flights,
      sendEmote: (emote: string) => socketRef.current?.emit('room:emote', { emote }),
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
      setAvatar: (avatar: Avatar) => {
        saveAvatar(avatar);
        socketRef.current?.emit('room:set_avatar', { avatar });
      },
      setReady: (ready: boolean) => socketRef.current?.emit('room:set_ready', { ready }),
      selectGame: (gameId: string) => socketRef.current?.emit('room:select_game', { gameId }),
      testMode,
      setTestMode: (enabled: boolean) => socketRef.current?.emit('room:set_test_mode', { enabled }),
      endGame: () => socketRef.current?.emit('room:end_game', undefined),
      kickLive: (playerId) => socketRef.current?.emit('room:kick_live', { playerId }),
      startGame: () =>
        new Promise((resolve) => {
          socketRef.current?.emit('room:start_game', {}, resolve);
        }),
      addAiPlayer: (persona: string) =>
        new Promise((resolve) => {
          socketRef.current?.emit('room:add_ai', { persona }, (res: { ok: boolean; error?: string }) => resolve(res));
        }),
      kickPlayer: (playerId: string) =>
        new Promise((resolve) => {
          socketRef.current?.emit('room:kick', { playerId }, resolve);
        }),
      sendChat: (text: string) => socketRef.current?.emit('room:chat', { text }),
      sendAction: (action) =>
        new Promise((resolve) => {
          socketRef.current?.emit('game:action', { action }, resolve);
        }),
      playAgain: () =>
        new Promise((resolve) => {
          socketRef.current?.emit('room:play_again', {}, resolve);
        }),
      returnToLobby: () => socketRef.current?.emit('room:return_to_lobby'),
      restartGame: () =>
        new Promise((resolve) => {
          socketRef.current?.emit('room:restart_game', {}, resolve);
        }),
      leaveRoom: () => {
        if (roomId) clearSession(roomId);
        socketRef.current?.emit('room:leave');
        setLobby(null);
        setView(null);
        viewRef.current = null;
        setChat([]);
        setRoomId(null);
        setMyPlayerId(null);
      },
    }),
    [socket, status, roomId, myPlayerId, lobby, testMode, view, chat, peekFlash, emotes, peekMarks, swapMarks, swapPairs, caboAnnounce, flights, unread, joinError, createRoom, joinRoom],
  );

  return api;
}
