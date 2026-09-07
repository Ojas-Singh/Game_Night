/**
 * Cosmetics: a small catalog of card backs and felt themes, lightweight
 * profiles, and loadouts. Everything is FREE — pick whatever you like.
 * (Monetization was deferred; the old purchase/Stripe plumbing was removed.
 * The catalog keeps the sku/slot shape so a store can return without
 * touching renderers or protocol.)
 */

import { randomBytes, createHash } from 'node:crypto';
import { log } from './log.js';

export type CosmeticSlot = 'cardBack' | 'feltTheme';

export interface CosmeticItem {
  sku: string;
  slot: CosmeticSlot;
  name: string;
  description: string;
}

export interface PlayerLoadout {
  cardBack?: string;
  feltTheme?: string;
}

export interface PlayerProfile {
  userId: string;
  createdAt: number;
  owned: string[];
  equipped: PlayerLoadout;
}

export const CATALOG: CosmeticItem[] = [
  // Card backs
  { sku: 'back-classic', slot: 'cardBack', name: 'Classic Back', description: 'The house standard: deep felt green with a gold star.' },
  { sku: 'back-verdant', slot: 'cardBack', name: 'Verdant', description: 'Vine-patterned back.' },
  { sku: 'back-midnight', slot: 'cardBack', name: 'Midnight', description: 'Indigo night sky with silver constellations.' },
  { sku: 'back-sunburst', slot: 'cardBack', name: 'Sunburst', description: 'Radiant amber rays for the bold bidder.' },
  { sku: 'back-royale', slot: 'cardBack', name: 'Royale', description: 'Gilded filigree on wine red. For hosts with taste.' },
  // Felt themes
  { sku: 'felt-emerald', slot: 'feltTheme', name: 'Emerald Felt', description: 'The classic casino green.' },
  { sku: 'felt-slate', slot: 'feltTheme', name: 'Slate Felt', description: 'Cool graphite felt.' },
  { sku: 'felt-azure', slot: 'feltTheme', name: 'Azure Felt', description: 'Deep ocean blue with a soft vignette.' },
  { sku: 'felt-crimson', slot: 'feltTheme', name: 'Crimson Felt', description: 'High-stakes red. The pot looks bigger on crimson.' },
];

export function itemBySku(sku: string): CosmeticItem | null {
  return CATALOG.find((item) => item.sku === sku) ?? null;
}

export interface CatalogEntry extends CosmeticItem {
  equipped: boolean;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

export interface ShopStore {
  loadProfile(userId: string): Promise<PlayerProfile | null>;
  saveProfile(profile: PlayerProfile): Promise<void>;
  userIdForToken(token: string): Promise<string | null>;
  bindToken(token: string, userId: string): Promise<void>;
}

function hashToken(token: string): string {
  // Store a digest, never the raw bearer token.
  return createHash('sha256').update(token).digest('hex');
}

export class MemoryShopStore implements ShopStore {
  private profiles = new Map<string, PlayerProfile>();
  private tokens = new Map<string, string>(); // tokenHash -> userId

  async loadProfile(userId: string): Promise<PlayerProfile | null> {
    return this.profiles.get(userId) ?? null;
  }
  async saveProfile(profile: PlayerProfile): Promise<void> {
    this.profiles.set(profile.userId, profile);
  }
  async userIdForToken(token: string): Promise<string | null> {
    return this.tokens.get(hashToken(token)) ?? null;
  }
  async bindToken(token: string, userId: string): Promise<void> {
    this.tokens.set(hashToken(token), userId);
  }
}

export class RedisShopStore implements ShopStore {
  constructor(
    private redis: { get(k: string): Promise<string | null>; set(k: string, v: string, mode: 'EX', ttl: number): Promise<unknown> },
    private ttlSeconds = 60 * 60 * 24 * 365 * 2,
  ) {}

  private userKey(userId: string): string {
    return `shop:user:${userId}`;
  }
  private tokenKey(token: string): string {
    return `shop:token:${hashToken(token)}`;
  }

  async loadProfile(userId: string): Promise<PlayerProfile | null> {
    const raw = await this.redis.get(this.userKey(userId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PlayerProfile;
    } catch {
      return null;
    }
  }
  async saveProfile(profile: PlayerProfile): Promise<void> {
    await this.redis.set(this.userKey(profile.userId), JSON.stringify(profile), 'EX', this.ttlSeconds);
  }
  async userIdForToken(token: string): Promise<string | null> {
    return this.redis.get(this.tokenKey(token));
  }
  async bindToken(token: string, userId: string): Promise<void> {
    await this.redis.set(this.tokenKey(token), userId, 'EX', this.ttlSeconds);
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ShopService {
  /** socketId -> userId (style events). */
  private socketUsers = new Map<string, string>();
  /** room playerId -> userId (loadouts). */
  private playerUsers = new Map<string, string>();

  constructor(private store: ShopStore) {}

  bindSocket(socketId: string, userId: string): void {
    this.socketUsers.set(socketId, userId);
  }
  unbindSocket(socketId: string): void {
    this.socketUsers.delete(socketId);
  }
  userForSocket(socketId: string): string | null {
    return this.socketUsers.get(socketId) ?? null;
  }
  /** Remember which profile a room seat belongs to (rebinds on rejoin). */
  bindPlayer(playerId: string, userId: string): void {
    this.playerUsers.set(playerId, userId);
  }
  userForPlayer(playerId: string): string | null {
    return this.playerUsers.get(playerId) ?? null;
  }

  /** Restore or create the profile behind a bearer token. All items free. */
  async resolveProfile(token?: string | null): Promise<{ token: string; profile: PlayerProfile; created: boolean }> {
    let userId: string | null = null;
    if (token) {
      userId = await this.store.userIdForToken(token);
      if (userId) {
        const existing = await this.store.loadProfile(userId);
        if (existing) return { token, profile: existing, created: false };
      }
    }
    const freshToken = randomBytes(32).toString('hex');
    const freshId = randomBytes(16).toString('hex');
    const profile: PlayerProfile = {
      userId: freshId,
      createdAt: Date.now(),
      owned: CATALOG.map((item) => item.sku),
      equipped: { cardBack: 'back-classic', feltTheme: 'felt-emerald' },
    };
    await this.store.saveProfile(profile);
    await this.store.bindToken(freshToken, freshId);
    return { token: freshToken, profile, created: true };
  }

  async profileForToken(token: string): Promise<PlayerProfile | null> {
    const userId = await this.store.userIdForToken(token);
    if (!userId) return null;
    return this.store.loadProfile(userId);
  }

  catalogFor(profile: PlayerProfile): CatalogEntry[] {
    return CATALOG.map((item) => ({
      ...item,
      equipped: profile.equipped.cardBack === item.sku || profile.equipped.feltTheme === item.sku,
    }));
  }

  async equip(userId: string, sku: string): Promise<{ ok: true; loadout: PlayerLoadout } | { ok: false; error: 'unknown_item' }> {
    const profile = await this.store.loadProfile(userId);
    if (!profile) return { ok: false, error: 'unknown_item' };
    const item = itemBySku(sku);
    if (!item) return { ok: false, error: 'unknown_item' };
    profile.equipped[item.slot] = sku;
    await this.store.saveProfile(profile);
    return { ok: true, loadout: profile.equipped };
  }

  loadoutsFor(playerIds: string[]): Record<string, PlayerLoadout> {
    // Synchronous best-effort snapshot refreshed by refreshLoadouts(); a
    // loadout change lags at most one lobbyState() push — an acceptable
    // trade for zero cross-service coupling.
    const out: Record<string, PlayerLoadout> = {};
    for (const pid of playerIds) {
      const loadout = this._loadoutCache[pid];
      if (loadout) out[pid] = loadout;
    }
    return out;
  }
  private _loadoutCache: Record<string, PlayerLoadout> = {};

  /** Called by the socket layer after joins/equips. */
  async refreshLoadouts(playerIds: string[]): Promise<Record<string, PlayerLoadout>> {
    const out: Record<string, PlayerLoadout> = {};
    for (const pid of playerIds) {
      const userId = this.userForPlayer(pid);
      if (!userId) continue;
      const profile = await this.store.loadProfile(userId);
      if (profile) out[pid] = profile.equipped;
    }
    this._loadoutCache = out;
    return out;
  }
}
