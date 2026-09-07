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
  /** Host sets the "first to N wins" series goal (null clears it). */
  'room:set_series_target': (payload: { target: number | null }) => void;
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
  'room:set_ai_debug': (payload: { enabled: boolean }) => void;
  /** Join the room's peer-to-peer voice/video mesh. */
  'media:join': (payload: { mic: boolean; cam: boolean }) => void;
  /** WebRTC signaling relay to one mesh member (offers, answers, ICE). */
  'media:signal': (payload: { to: string; data: unknown }) => void;
  'media:update': (payload: { mic: boolean; cam: boolean }) => void;
  'media:leave': () => void;
  /** Attach (or create) the caller's cosmetics profile. */
  'shop:hello': (payload: { token?: string | null }, ack: (res: ShopHelloResult) => void) => void;
  /** Buy a paid sku (returns a Stripe Checkout URL when configured). */
  'shop:purchase': (payload: { sku: string }, ack: (res: PurchaseAck) => void) => void;
  /** Equip an owned cosmetic (server verifies ownership). */
  'shop:equip': (payload: { sku: string }, ack: (res: { ok: boolean; error?: string }) => void) => void;
}

export interface JoinResult {
  ok: boolean;
  error?: string;
  roomId?: string;
  playerId?: string;
  playerToken?: string;
}

// --- Shop -------------------------------------------------------------------

export interface ShopHelloResult {
  ok: boolean;
  token: string;
  profile: {
    userId: string;
    gamesPlayed: number;
    owned: string[];
    equipped: { cardBack?: string; feltTheme?: string };
  };
  catalog: ShopCatalogEntry[];
  stripeEnabled: boolean;
}

export interface ShopCatalogEntry {
  sku: string;
  slot: 'cardBack' | 'feltTheme';
  name: string;
  description: string;
  priceCents: number;
  unlockAfterGames: number;
  owned: boolean;
  unlocked: boolean;
  equipped: boolean;
}

export interface PurchaseAck {
  ok: boolean;
  granted?: boolean;
  checkoutUrl?: string;
  error?: 'unknown_item' | 'locked' | 'store_unavailable' | 'checkout_failed';
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
  spectator?: boolean;
  spectatorCount?: number;
  allowSpectators?: boolean;
  roomId: string;
  gameId: string;
  players: LobbyPlayer[];
  inGame: boolean;
  hostId: string;
  /** Cumulative match scoreboard across rounds (public). */
  scoreboard: Record<string, number>;
  /** Host-selected optional 5–6 "swap others" power. */
  /** Test Mode: all cards revealed to everyone (debug/test aid). */
  testMode: boolean;
  /** Host-only debug switch for live AI decision traces. */
  aiDebug: boolean;
  /** Recent AI traces are sent only to the host's socket. */
  aiThoughts?: AiDecisionTrace[];
  /** Host-set "first to N wins" series goal; null = no series. */
  seriesTarget?: number | null;
  /** Equipped cosmetics per seated player (server-verified ownership). */
  loadouts?: Record<string, { cardBack?: string; feltTheme?: string }>;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

export interface AiAttemptTrace {
  attempt: number;
  status: 'accepted' | 'failed';
  latencyMs: number;
  httpStatus?: number;
  finishReason?: string;
  usage?: TokenUsage;
  reasoningAvailable?: boolean;
  /** Provider chain-of-thought text for this request, when it returned one. */
  reasoning?: string;
  failure?: string;
}

export interface AiDecisionTrace {
  id: string;
  version: number;
  sequence: number;
  status: 'thinking' | 'decision' | 'executed' | 'failed';
  startedAt: string;
  updatedAt: string;
  playerId: string;
  playerName: string;
  /** Concise model-provided explanation from the JSON answer. */
  summary?: string;
  /** Model-provided decision factors grounded in the filtered observation. */
  rationale?: string[];
  providerReasoningAvailable?: boolean;
  /** Provider chain-of-thought text, when the model returned one (host-only inspector). */
  providerReasoning?: string;
  source: string;
  model?: string;
  proposedAction?: string;
  executedAction?: string;
  decisionSource?: string;
  failure?: string;
  latencyMs?: number;
  attempts: AiAttemptTrace[];
  usage?: TokenUsage;
  finishReason?: string;
  /** Available only in an explicitly marked Test Mode inspection room. */
  observation?: string;
  candidates?: string[];
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
  'room:ai_thought': (trace: AiDecisionTrace) => void;
  /** Full mesh roster, sent to media members after any membership change. */
  'media:peers': (payload: { peers: MediaMemberInfo[] }) => void;
  /** Relayed WebRTC signaling from another member. */
  'media:signal': (payload: { from: string; data: unknown }) => void;
  /** Free items newly unlocked by games played (pushed to their owner). */
  'shop:granted': (payload: { skus: string[] }) => void;
}

/** Subset of the mesh roster clients see (never socket ids). */
export interface MediaMemberInfo {
  playerId: string;
  mic: boolean;
  cam: boolean;
}
