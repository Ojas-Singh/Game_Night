/**
 * Cosmetics shop: lightweight profiles, a small free-friendly catalog,
 * entitlements, games-played unlocks, and Stripe Checkout for paid items.
 *
 * Design rules:
 * - The SERVER owns entitlements. Clients may only ask; a sku not in the
 *   caller's inventory can never be equipped.
 * - Free items are either starter items or auto-awarded at a games-played
 *   threshold (server-awarded, capped by the catalog — no grind exploits).
 * - Paid items grant ONLY from the Stripe webhook (checkout.session.completed
 *   metadata), never from a client claim.
 * - Identity is a bearer profile token (random 32 bytes) the client stores in
 *   localStorage — an upgrade-to-OAuth path can attach later without schema
 *   changes because everything keys on an opaque userId.
 */

import { randomBytes, createHash } from 'node:crypto';
import Stripe from 'stripe';
import { log } from './log.js';

export type CosmeticSlot = 'cardBack' | 'feltTheme';

export interface ShopItem {
  sku: string;
  slot: CosmeticSlot;
  name: string;
  description: string;
  /** 0 = free. Paid items are one-time purchases in US cents. */
  priceCents: number;
  /** Auto-awarded once the profile has played this many rounds. */
  unlockAfterGames: number;
}

export interface PlayerLoadout {
  cardBack?: string;
  feltTheme?: string;
}

export interface PlayerProfile {
  userId: string;
  createdAt: number;
  gamesPlayed: number;
  owned: string[];
  equipped: PlayerLoadout;
}

export const RESERVED_SKU = 'none';

export const CATALOG: ShopItem[] = [
  // Card backs
  { sku: 'back-classic', slot: 'cardBack', name: 'Classic Back', description: 'The house standard: deep felt green with a gold star.', priceCents: 0, unlockAfterGames: 0 },
  { sku: 'back-verdant', slot: 'cardBack', name: 'Verdant', description: 'Vine-patterned back. Unlocks after 3 rounds played.', priceCents: 0, unlockAfterGames: 3 },
  { sku: 'back-midnight', slot: 'cardBack', name: 'Midnight', description: 'Indigo night sky with silver constellations.', priceCents: 299, unlockAfterGames: 0 },
  { sku: 'back-sunburst', slot: 'cardBack', name: 'Sunburst', description: 'Radiant amber rays for the bold bidder.', priceCents: 499, unlockAfterGames: 0 },
  { sku: 'back-royale', slot: 'cardBack', name: 'Royale', description: 'Gilded filigree on wine red. For hosts with taste.', priceCents: 999, unlockAfterGames: 0 },
  // Felt themes
  { sku: 'felt-emerald', slot: 'feltTheme', name: 'Emerald Felt', description: 'The classic casino green.', priceCents: 0, unlockAfterGames: 0 },
  { sku: 'felt-slate', slot: 'feltTheme', name: 'Slate Felt', description: 'Cool graphite felt. Unlocks after 5 rounds played.', priceCents: 0, unlockAfterGames: 5 },
  { sku: 'felt-azure', slot: 'feltTheme', name: 'Azure Felt', description: 'Deep ocean blue with a soft vignette.', priceCents: 299, unlockAfterGames: 0 },
  { sku: 'felt-crimson', slot: 'feltTheme', name: 'Crimson Felt', description: 'High-stakes red. The pot looks bigger on crimson.', priceCents: 499, unlockAfterGames: 0 },
];

export function itemBySku(sku: string): ShopItem | null {
  return CATALOG.find((item) => item.sku === sku) ?? null;
}

export interface CatalogEntry extends ShopItem {
  owned: boolean;
  /** Free-by-play item whose threshold the profile has reached. */
  unlocked: boolean;
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

export interface ShopServiceOptions {
  store: ShopStore;
  /** Stripe secret key — paid checkout activates only when present. */
  stripeSecretKey?: string;
  /** Public origin for Stripe success/cancel redirects. */
  appOrigin?: string;
}

export type PurchaseResult =
  | { ok: true; granted: boolean; checkoutUrl?: string }
  | { ok: false; error: 'unknown_item' | 'locked' | 'store_unavailable' | 'checkout_failed' };

export class ShopService {
  private stripe: Stripe | null = null;
  /** socketId -> userId (shop event handlers). */
  private socketUsers = new Map<string, string>();
  /** room playerId -> userId (loadouts + round crediting). */
  private playerUsers = new Map<string, string>();

  constructor(private opts: ShopServiceOptions) {
    if (opts.stripeSecretKey) {
      try {
        this.stripe = new Stripe(opts.stripeSecretKey);
      } catch (err) {
        log.warn('shop_stripe_unavailable', { error: err instanceof Error ? err.message : 'unknown' });
      }
    }
  }

  get stripeEnabled(): boolean {
    return this.stripe !== null;
  }

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

  /** Restore or create the profile behind a bearer token. */
  async resolveProfile(token?: string | null): Promise<{ token: string; profile: PlayerProfile; created: boolean }> {
    let userId: string | null = null;
    if (token) {
      userId = await this.opts.store.userIdForToken(token);
      if (userId) {
        const existing = await this.opts.store.loadProfile(userId);
        if (existing) return { token, profile: existing, created: false };
      }
    }
    const freshToken = randomBytes(32).toString('hex');
    const freshId = randomBytes(16).toString('hex');
    const profile: PlayerProfile = {
      userId: freshId,
      createdAt: Date.now(),
      gamesPlayed: 0,
      // Starters: free items with no play threshold. Everything else must be
      // unlocked by rounds played or granted by a verified purchase.
      owned: CATALOG.filter((item) => item.priceCents === 0 && item.unlockAfterGames === 0).map((item) => item.sku),
      equipped: { cardBack: 'back-classic', feltTheme: 'felt-emerald' },
    };
    await this.opts.store.saveProfile(profile);
    await this.opts.store.bindToken(freshToken, freshId);
    return { token: freshToken, profile, created: true };
  }

  async profileForToken(token: string): Promise<PlayerProfile | null> {
    const userId = await this.opts.store.userIdForToken(token);
    if (!userId) return null;
    return this.opts.store.loadProfile(userId);
  }

  catalogFor(profile: PlayerProfile): CatalogEntry[] {
    const owned = new Set(profile.owned);
    return CATALOG.map((item) => ({
      ...item,
      owned: owned.has(item.sku),
      unlocked:
        item.priceCents === 0 &&
        (item.unlockAfterGames === 0 || profile.gamesPlayed >= item.unlockAfterGames),
      equipped:
        profile.equipped.cardBack === item.sku || profile.equipped.feltTheme === item.sku,
    }));
  }

  async equip(userId: string, sku: string): Promise<{ ok: true; loadout: PlayerLoadout } | { ok: false; error: 'unknown_item' | 'not_owned' }> {
    const profile = await this.opts.store.loadProfile(userId);
    if (!profile) return { ok: false, error: 'unknown_item' };
    if (sku === RESERVED_SKU) {
      // Clearing: pick which slot by context — a bare 'none' clears nothing;
      // clients clear by equipping another owned item.
      return { ok: true, loadout: profile.equipped };
    }
    const item = itemBySku(sku);
    if (!item) return { ok: false, error: 'unknown_item' };
    if (!profile.owned.includes(sku)) return { ok: false, error: 'not_owned' };
    profile.equipped[item.slot] = sku;
    await this.opts.store.saveProfile(profile);
    return { ok: true, loadout: profile.equipped };
  }

  async purchase(userId: string, sku: string): Promise<PurchaseResult> {
    const profile = await this.opts.store.loadProfile(userId);
    if (!profile) return { ok: false, error: 'unknown_item' };
    const item = itemBySku(sku);
    if (!item) return { ok: false, error: 'unknown_item' };
    if (profile.owned.includes(sku)) return { ok: true, granted: false };
    if (item.priceCents === 0) {
      if (item.unlockAfterGames > profile.gamesPlayed) return { ok: false, error: 'locked' };
      profile.owned.push(sku);
      await this.opts.store.saveProfile(profile);
      log.info('shop_grant', { userId: profile.userId, sku, free: true });
      return { ok: true, granted: true };
    }
    if (!this.stripe || !this.opts.appOrigin) return { ok: false, error: 'store_unavailable' };
    try {
      const session = await this.stripe.checkout.sessions.create({
        mode: 'payment',
        client_reference_id: `${userId}:${sku}`,
        metadata: { userId, sku },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: item.priceCents,
              product_data: { name: `Cabo — ${item.name}`, description: item.description },
            },
          },
        ],
        success_url: `${this.opts.appOrigin}/shop?checkout=success`,
        cancel_url: `${this.opts.appOrigin}/shop?checkout=cancelled`,
      });
      return { ok: true, granted: false, checkoutUrl: session.url ?? undefined };
    } catch (err) {
      log.error('shop_checkout_error', { error: err instanceof Error ? err.message : 'unknown' });
      return { ok: false, error: 'checkout_failed' };
    }
  }

  /** Credit one completed round and auto-award any newly unlocked items. */
  async creditGame(userId: string): Promise<string[]> {
    const profile = await this.opts.store.loadProfile(userId);
    if (!profile) return [];
    profile.gamesPlayed += 1;
    const awarded: string[] = [];
    for (const item of CATALOG) {
      if (
        item.unlockAfterGames > 0 &&
        item.unlockAfterGames <= profile.gamesPlayed &&
        !profile.owned.includes(item.sku)
      ) {
        profile.owned.push(item.sku);
        awarded.push(item.sku);
      }
    }
    await this.opts.store.saveProfile(profile);
    return awarded;
  }

  /** Credit one completed round per seat and auto-award unlocks.
   *  Returns { playerId -> newly awarded skus } for seats with profiles. */
  async creditPlayers(playerIds: string[]): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const pid of playerIds) {
      const userId = this.playerUsers.get(pid);
      if (!userId) continue;
      const awarded = await this.creditGame(userId);
      if (awarded.length > 0) out[pid] = awarded;
    }
    return out;
  }

  /** Stripe webhook: verify signature, then grant the entitlement. */
  async handleWebhook(rawBody: string, signature: string, secret: string): Promise<{ handled: boolean; granted?: string; userId?: string }> {
    if (!this.stripe) return { handled: false };
    let event: { type: string; data: { object: { metadata?: unknown } } };
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, secret) as unknown as typeof event;
    } catch (err) {
      log.warn('shop_webhook_bad_signature', { error: err instanceof Error ? err.message : 'unknown' });
      return { handled: false };
    }
    if (event.type !== 'checkout.session.completed') return { handled: true };
    const session = event.data.object;
    const metadata = (session.metadata ?? {}) as { userId?: string; sku?: string };
    const userId = typeof metadata.userId === 'string' ? metadata.userId : null;
    const sku = typeof metadata.sku === 'string' ? metadata.sku : null;
    if (!userId || !sku) return { handled: true };
    const profile = await this.opts.store.loadProfile(userId);
    if (!profile || profile.owned.includes(sku)) return { handled: true, granted: sku ?? undefined, userId };
    const item = itemBySku(sku);
    if (!item || item.priceCents === 0) return { handled: true };
    profile.owned.push(sku);
    await this.opts.store.saveProfile(profile);
    log.info('shop_purchase', { userId, sku, amountCents: item.priceCents });
    return { handled: true, granted: sku, userId };
  }

  loadoutsFor(playerIds: string[]): Record<string, PlayerLoadout> {
    // Synchronous best-effort snapshot refreshed by refreshLoadouts(); a
    // profile change lags at most one lobbyState() push — an acceptable
    // trade for zero cross-service coupling.
    const out: Record<string, PlayerLoadout> = {};
    for (const pid of playerIds) {
      const loadout = this._loadoutCache[pid];
      if (loadout) out[pid] = loadout;
    }
    return out;
  }
  private _loadoutCache: Record<string, PlayerLoadout> = {};

  /** Called by the socket layer after joins/equips/purchases. */
  async refreshLoadouts(playerIds: string[]): Promise<Record<string, PlayerLoadout>> {
    const out: Record<string, PlayerLoadout> = {};
    for (const pid of playerIds) {
      const userId = this.userForPlayer(pid);
      if (!userId) continue;
      const profile = await this.opts.store.loadProfile(userId);
      if (profile) out[pid] = profile.equipped;
    }
    this._loadoutCache = out;
    return out;
  }
}
