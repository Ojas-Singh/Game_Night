/**
 * Wire protocol between clients and the server (Socket.IO event names and
 * payload shapes). Platform-level only — game actions are opaque envelopes
 * routed through the engine interface, so new games need no protocol changes.
 */

import type { GameAction } from '@game-night/shared';
import type { CaboPlayerView } from '@game-night/engine-cabo';
import type { PairOnePlayerView } from '@game-night/engine-pairone';

/** Any game's filtered per-player view. */
export type AnyGameView = CaboPlayerView | PairOnePlayerView;

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

/** A customizable player avatar (skribbl-style): indices into the client's
 *  option lists; the server only validates the ranges. */
export interface Avatar {
  color: number;
  eyes: number;
  mouth: number;
  hat: number;
}

export const AVATAR_LIMITS = {
  color: 12,
  eyes: 6,
  mouth: 6,
  hat: 6,
} as const;

export function isValidAvatar(a: unknown): a is Avatar {
  if (typeof a !== 'object' || a === null) return false;
  const v = a as Record<string, unknown>;
  return (
    typeof v.color === 'number' && typeof v.eyes === 'number' &&
    typeof v.mouth === 'number' && typeof v.hat === 'number' &&
    Number.isInteger(v.color) && Number.isInteger(v.eyes) &&
    Number.isInteger(v.mouth) && Number.isInteger(v.hat) &&
    v.color >= 0 && v.color < AVATAR_LIMITS.color &&
    v.eyes >= 0 && v.eyes < AVATAR_LIMITS.eyes &&
    v.mouth >= 0 && v.mouth < AVATAR_LIMITS.mouth &&
    v.hat >= 0 && v.hat < AVATAR_LIMITS.hat
  );
}

export function randomAvatar(): Avatar {
  const r = (n: number) => Math.floor(Math.random() * n);
  return { color: r(AVATAR_LIMITS.color), eyes: r(AVATAR_LIMITS.eyes), mouth: r(AVATAR_LIMITS.mouth), hat: r(AVATAR_LIMITS.hat) };
}

export interface ClientEvents {
  'room:create': (payload: { name: string }, ack: (res: JoinResult) => void) => void;
  'room:join': (payload: { roomId: string; name?: string; playerToken?: string }, ack: (res: JoinResult) => void) => void;
  'room:set_name': (payload: { name: string }) => void;
  'room:set_avatar': (payload: { avatar: Avatar }) => void;
  'room:set_ready': (payload: { ready: boolean }) => void;
  'room:select_game': (payload: { gameId: string }) => void;
  'room:set_swap_others': (payload: { enabled: boolean }) => void;
  /** Host removes a player from the lobby. */
  'room:kick': (payload: { playerId: string }, ack: (res: { ok: boolean; error?: string }) => void) => void;
  'room:start_game': (payload: {}, ack: (res: { ok: boolean; error?: string }) => void) => void;
  'room:chat': (payload: { text: string }) => void;
  'room:emote': (payload: { emote: string }) => void;
  'room:leave': () => void;
  'game:action': (payload: { action: GameAction }, ack: (res: { ok: boolean; error?: string }) => void) => void;
  'room:return_to_lobby': () => void;
  'room:restart_game': (payload: {}, ack: (res: { ok: boolean; error?: string }) => void) => void;
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
  avatar: Avatar;
  /** 'ai' players are driven by the server's agent loop. */
  kind?: 'human' | 'ai';
  aiPersona?: string;
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
  'game:view': (view: AnyGameView | { spectator: true }) => void;
  'room:closed': (payload: { reason: string }) => void;
}
