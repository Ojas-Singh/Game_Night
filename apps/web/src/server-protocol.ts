/**
 * Wire protocol types (client-side mirror of apps/server/src/protocol.ts).
 * Type-only — kept in sync by tests.
 */

import type { GameAction } from '@shared/game.js';
import type { CaboPlayerView } from '@cabo/views.js';
import type { PairOnePlayerView } from '@pairone/views.js';

/** Any game's filtered per-player view. */
/** Opaque view from the internal rulezero service (§16) — rendered
 * generically by RuleZeroTable. */
export interface RuleZeroPlayerView {
  review?: {
    nashConv: number | null;
    decisions: {
      step: number;
      player: number;
      chosen?: string | null;
      referenceTop?: [string, number] | null;
      distribution: [string, number][];
    }[];
  };
  gameId: 'rulezero';
  rz: {
    protocol: string;
    specHash: string;
    player: number;
    phase?: string;
    observation: string;
    informationState: string;
    isTerminal: boolean;
    currentActor: number | null;
    candidates: { candidateId: string; environmentActionId: number; label: string }[];
    zones: {
      id: string;
      visibility: 'hidden' | 'owner' | 'public';
      owner: number | null;
      cards?: number[];
      count?: number;
    }[];
    scores?: Record<string, number>;
  };
}

export type AnyGameView =
  | CaboPlayerView
  | PairOnePlayerView
  | RuleZeroPlayerView;

export interface JoinResult {
  ok: boolean;
  error?: string;
  roomId?: string;
  playerId?: string;
  playerToken?: string;
}

/** Customizable player avatar (skribbl-style). */
export interface Avatar {
  color: number;
  eyes: number;
  mouth: number;
  hat: number;
}

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
  scoreboard: Record<string, number>;
  swapOthersEnabled: boolean;
  testMode: boolean;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  playerId: string | null;
  playerName: string | null;
  text: string;
  timestamp: string;
}

export type ClientToServerEvents = {
  'room:create': (payload: { name: string }, ack: (res: JoinResult) => void) => void;
  'room:join': (
    payload: { roomId: string; name?: string; playerToken?: string },
    ack: (res: JoinResult) => void,
  ) => void;
  'room:set_name': (payload: { name: string }) => void;
  'room:set_avatar': (payload: { avatar: Avatar }) => void;
  'room:set_ready': (payload: { ready: boolean }) => void;
  'room:select_game': (payload: { gameId: string }) => void;
  'room:set_swap_others': (payload: { enabled: boolean }) => void;
  'room:kick': (payload: { playerId: string }, ack: (res: { ok: boolean; error?: string }) => void) => void;
  'room:start_game': (payload: Record<string, never>, ack: (res: { ok: boolean; error?: string }) => void) => void;
  'room:chat': (payload: { text: string }) => void;
  'room:leave': () => void;
  'game:action': (payload: { action: GameAction }, ack: (res: { ok: boolean; error?: string }) => void) => void;
  'room:return_to_lobby': () => void;
  'room:restart_game': (payload: Record<string, never>, ack: (res: { ok: boolean; error?: string }) => void) => void;
  'room:play_again': (payload: Record<string, never>, ack: (res: { ok: boolean; error?: string }) => void) => void;
};

export type ServerToClientEvents = {
  'room:state': (state: RoomLobbyState) => void;
  'room:chat': (message: ChatMessage) => void;
  'room:emote': (payload: { playerId: string; emote: string; timestamp: string }) => void;
  'game:view': (view: AnyGameView) => void;
  'room:closed': (payload: { reason: string }) => void;
};

export type { GameAction, CaboPlayerView, PairOnePlayerView };
