/**
 * Shop entitlement tests with the in-memory store — no Redis, no Stripe, no
 * network. These pin the security-critical rules: server-owned entitlements,
 * threshold-gated free items, and webhook-only paid grants.
 */

import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  MemoryShopStore,
  ShopService,
  itemBySku,
  type PlayerProfile,
} from '../src/shop.js';

function service(overrides: Partial<ConstructorParameters<typeof ShopService>[0]> = {}): ShopService {
  return new ShopService({ store: new MemoryShopStore(), ...overrides });
}

async function profileOf(svc: ShopService, token?: string): Promise<{ token: string; profile: PlayerProfile }> {
  const resolved = await svc.resolveProfile(token);
  return { token: resolved.token, profile: resolved.profile };
}

describe('profiles', () => {
  it('creates a fresh profile with starter items on first hello', async () => {
    const svc = service();
    const { profile } = await profileOf(svc);
    expect(profile.owned).toContain('back-classic');
    expect(profile.owned).toContain('felt-emerald');
    expect(profile.owned).not.toContain('back-midnight');
    expect(profile.gamesPlayed).toBe(0);
  });

  it('restores the same profile from the same token', async () => {
    const svc = service();
    const first = await profileOf(svc);
    await svc.equip(first.profile.userId, 'back-midnight').then((res) => {
      // not owned yet — must be refused
      expect(res.ok).toBe(false);
    });
    const second = await profileOf(svc, first.token);
    expect(second.profile.userId).toBe(first.profile.userId);
    expect(second.profile.owned).toEqual(first.profile.owned);
  });

  it('rejects tokens it never issued', async () => {
    const svc = service();
    const profile = await svc.profileForToken('forged-token');
    expect(profile).toBeNull();
  });
});

describe('catalog + equip', () => {
  it('marks ownership and equipped state in the catalog', async () => {
    const svc = service();
    const { profile } = await profileOf(svc);
    const entries = svc.catalogFor(profile);
    const classic = entries.find((e) => e.sku === 'back-classic')!;
    expect(classic.owned).toBe(true);
    expect(classic.equipped).toBe(true);
    const midnight = entries.find((e) => e.sku === 'back-midnight')!;
    expect(midnight.owned).toBe(false);
    expect(midnight.unlocked).toBe(false);
  });

  it('equips owned items and refuses unowned ones', async () => {
    const svc = service();
    const { profile } = await profileOf(svc);
    const ok = await svc.equip(profile.userId, 'back-verdant');
    expect(ok.ok).toBe(false); // locked free item, not owned

    const granted = await svc.creditGame(profile.userId);
    expect(granted).toEqual([]); // 1 game < threshold 3
    const equipped = await svc.equip(profile.userId, 'back-classic');
    expect(equipped.ok).toBe(true);
  });
});

describe('games-played unlocks', () => {
  it('awards Verdant at 3 rounds and Slate at 5, exactly once', async () => {
    const svc = service();
    const { profile } = await profileOf(svc);
    expect(await svc.creditGame(profile.userId)).toEqual([]);
    expect(await svc.creditGame(profile.userId)).toEqual([]);
    expect(await svc.creditGame(profile.userId)).toEqual(['back-verdant']);
    expect(await svc.creditGame(profile.userId)).toEqual([]);
    expect(await svc.creditGame(profile.userId)).toEqual(['felt-slate']);
    expect(await svc.creditGame(profile.userId)).toEqual([]); // capped
  });

  it('lets the player equip an unlocked free item', async () => {
    const svc = service();
    const { profile } = await profileOf(svc);
    for (let i = 0; i < 3; i++) await svc.creditGame(profile.userId);
    const res = await svc.equip(profile.userId, 'back-verdant');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.loadout.cardBack).toBe('back-verdant');
  });
});

describe('purchase', () => {
  it('grants unlocked free items, refuses locked ones, and re-claims idempotently', async () => {
    const store = new MemoryShopStore();
    const svc = new ShopService({ store });
    const { profile } = await profileOf(svc);
    const locked = await svc.purchase(profile.userId, 'back-verdant');
    expect(locked).toEqual({ ok: false, error: 'locked' });
    for (let i = 0; i < 3; i++) await svc.creditGame(profile.userId);
    // Auto-award reached it first — a purchase attempt is a harmless no-op.
    const alreadyOwned = await svc.purchase(profile.userId, 'back-verdant');
    expect(alreadyOwned).toEqual({ ok: true, granted: false });
    // Stale profile (created before the auto-award): claim still grants.
    profile.owned = profile.owned.filter((sku) => sku !== 'back-verdant');
    await store.saveProfile(profile);
    const claim = await svc.purchase(profile.userId, 'back-verdant');
    expect(claim).toEqual({ ok: true, granted: true });
  });

  it('refuses paid checkout when Stripe is not configured', async () => {
    const svc = service();
    const { profile } = await profileOf(svc);
    const res = await svc.purchase(profile.userId, 'back-midnight');
    expect(res).toEqual({ ok: false, error: 'store_unavailable' });
    expect(profile.owned).not.toContain('back-midnight');
  });

  it('grants paid items ONLY from a verified webhook event', async () => {
    const svc = service();
    const { profile } = await profileOf(svc);
    // Webhook without Stripe configured is not handled.
    const unhandled = await svc.handleWebhook('{}', 'sig', 'whsec_x');
    expect(unhandled.handled).toBe(false);
    expect(profile.owned).not.toContain('back-midnight');
  });
});

describe('catalog integrity', () => {
  it('has unique skus and consistent slots', () => {
    const skus = new Set(CATALOG.map((item) => item.sku));
    expect(skus.size).toBe(CATALOG.length);
    for (const item of CATALOG) {
      expect(itemBySku(item.sku)?.slot).toBe(item.slot);
      expect(item.priceCents).toBeGreaterThanOrEqual(0);
      expect(item.unlockAfterGames).toBeGreaterThanOrEqual(0);
    }
  });
});
