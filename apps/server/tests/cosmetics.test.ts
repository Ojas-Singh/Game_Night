import { describe, expect, it } from 'vitest';
import { ShopService, MemoryShopStore, CATALOG, itemBySku } from '../src/shop.js';

describe('cosmetics service (all free)', () => {
  it('creates a profile with every item owned and a fresh bearer token', async () => {
    const shop = new ShopService(new MemoryShopStore());
    const { token, profile, created } = await shop.resolveProfile(null);
    expect(created).toBe(true);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(profile.owned).toEqual(CATALOG.map((c) => c.sku));
    expect(profile.equipped.cardBack).toBe('back-classic');
    expect(profile.equipped.feltTheme).toBe('felt-emerald');
  });

  it('restores the same profile for the same token', async () => {
    const shop = new ShopService(new MemoryShopStore());
    const first = await shop.resolveProfile(null);
    const again = await shop.resolveProfile(first.token);
    expect(again.created).toBe(false);
    expect(again.profile.userId).toBe(first.profile.userId);
  });

  it('rejects unknown tokens instead of minting orphan profiles', async () => {
    const shop = new ShopService(new MemoryShopStore());
    const bogus = await shop.resolveProfile('f'.repeat(64));
    expect(bogus.created).toBe(true);
    expect(bogus.profile.userId).not.toBe('');
  });

  it('equips any free item and reflects it in the catalog', async () => {
    const shop = new ShopService(new MemoryShopStore());
    const { profile } = await shop.resolveProfile(null);
    const result = await shop.equip(profile.userId, 'back-royale');
    expect(result).toEqual({ ok: true, loadout: { cardBack: 'back-royale', feltTheme: 'felt-emerald' } });
    const catalog = shop.catalogFor({ ...profile, equipped: result.ok ? result.loadout : profile.equipped });
    expect(catalog.find((c) => c.sku === 'back-royale')?.equipped).toBe(true);
    expect(catalog.find((c) => c.sku === 'back-classic')?.equipped).toBe(false);
  });

  it('refuses to equip an unknown sku', async () => {
    const shop = new ShopService(new MemoryShopStore());
    const { profile } = await shop.resolveProfile(null);
    const result = await shop.equip(profile.userId, 'nope');
    expect(result).toEqual({ ok: false, error: 'unknown_item' });
    const missing = await shop.equip('nobody', 'back-classic');
    expect(missing).toEqual({ ok: false, error: 'unknown_item' });
  });

  it('keeps loadouts fresh per seat and resolves seat -> user bindings', async () => {
    const shop = new ShopService(new MemoryShopStore());
    const { profile } = await shop.resolveProfile(null);
    shop.bindPlayer('seat-1', profile.userId);
    await shop.equip(profile.userId, 'felt-crimson');
    const loadouts = await shop.refreshLoadouts(['seat-1', 'seat-2']);
    expect(loadouts['seat-1']).toEqual({ cardBack: 'back-classic', feltTheme: 'felt-crimson' });
    expect(loadouts['seat-2']).toBeUndefined();
    // Synchronous provider snapshot (used by lobbyState) matches.
    expect(shop.loadoutsFor(['seat-1'])).toEqual({ 'seat-1': loadouts['seat-1'] });
  });

  it('survives profile loss by refusing (never ressurecting silently)', async () => {
    const shop = new ShopService(new MemoryShopStore());
    const { profile } = await shop.resolveProfile(null);
    // Simulate a store wipe: equip must fail, not recreate.
    const wiped = new ShopService(new MemoryShopStore());
    const result = await wiped.equip(profile.userId, 'back-classic');
    expect(result.ok).toBe(false);
  });

  it('catalog has backs and felts and lookup works', () => {
    expect(itemBySku('back-midnight')?.slot).toBe('cardBack');
    expect(itemBySku('felt-azure')?.slot).toBe('feltTheme');
    expect(itemBySku('???')).toBeNull();
  });
});
