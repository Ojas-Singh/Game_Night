/**
 * Wire protocol between clients and the server (Socket.IO event names and
 * payload shapes). Platform-level only — game actions are opaque envelopes
 * routed through the engine interface, so new games need no protocol changes.
 */

import type { GameAction } from '@game-night/shared';
import type { CaboPlayerView } from '@game-night/engine-cabo';

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export interface ClientEvents {
  'room:create': (payload: { name: string }, ack: (res: JoinResult) => void) => void;
  'room:join': (payload: { roomId: string; name?: string; playerToken?: string }, ack: (res: JoinResult) => void) => void;
  'room:set_name': (payload: { name: string }) => void;
  'room:set_ready': (payload: { ready: boolean }) => void;
  'room:select_game': (payload: { gameId: string }) => void;
  'room:set_swap_others': (payload: { enabled: boolean }) => void;
  'room:start_game': (payload: {}, ack: (res: { ok: boolean; error?: string }) => void) => void;
  'room:chat': (payload: { text: string }) => void;
  'room:emote': (payload: { emote: string }) => void;
  'room:leave': () => void;
  'game:action': (payload: { action: GameAction }, ack: (res: { ok: boolean; error?: string }) => void) => void;
  'room:return_to_lobby': () => void;
  'room:play_again': (payload: {}, ack: (res: { ok: boolean; error?: string }) => void) => void;
}

export interface JoinResult {
  ok: boolean;
  error?: string;
  roomId?: string;
  playerId?: string;
  playerToken?: string;
}

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export interface LobbyPlayer {
  id: string;
  name: string;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
  isYou: boolean;
}

export interface RoomLobbyState {
  roomId: string;
  gameId: string;
  players: LobbyPlayer[];
  inGame: boolean;
  hostId: string;
  /** Cumulative match scoreboard across rounds (public). */
  scoreboard: Record<string, number>;
  /** Host-selected optional 5–6 "swap others" power. */
  swapOthersEnabled: boolean;
  /** Test Mode: all cards revealed to everyone (debug/test aid). */
  testMode: boolean;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  playerId: string | null; // null → system message
  playerName: string | null;
  text: string;
  timestamp: string;
}

export interface ServerEvents {
  'room:state': (state: RoomLobbyState) => void;
  'room:chat': (message: ChatMessage) => void;
  'room:emote': (payload: { playerId: string; emote: string; timestamp: string }) => void;
  'game:view': (view: CaboPlayerView | { spectator: true }) => void;
  'room:closed': (payload: { reason: string }) => void;
}
