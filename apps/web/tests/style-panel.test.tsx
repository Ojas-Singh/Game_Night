/** Style picker selection: chip click -> equip, and slot-scoped ✓ flipping. */

import { describe, expect, it, vi } from 'vitest';
import { flipCatalog } from '../src/useShop.js';
import type { ShopCatalogEntry } from '../src/server-protocol.js';

function entry(sku: string, slot: 'cardBack' | 'feltTheme', equipped = false): ShopCatalogEntry {
  return { sku, slot, name: sku, description: '', equipped };
}

const CATALOG: ShopCatalogEntry[] = [
  entry('back-classic', 'cardBack', true),
  entry('back-royale', 'cardBack'),
  entry('felt-emerald', 'feltTheme', true),
  entry('felt-crimson', 'feltTheme'),
];

describe('flipCatalog (style chip selection)', () => {
  it('moves the ✓ to the picked sku within its slot', () => {
    const next = flipCatalog(CATALOG, 'back-royale');
    expect(next.find((e) => e.sku === 'back-royale')?.equipped).toBe(true);
    expect(next.find((e) => e.sku === 'back-classic')?.equipped).toBe(false);
  });

  it('does not disturb the other slot (equipped felt stays equipped)', () => {
    const next = flipCatalog(CATALOG, 'back-royale');
    expect(next.find((e) => e.sku === 'felt-emerald')?.equipped).toBe(true);
    const feltFlip = flipCatalog(CATALOG, 'felt-crimson');
    expect(feltFlip.find((e) => e.sku === 'felt-crimson')?.equipped).toBe(true);
    expect(feltFlip.find((e) => e.sku === 'back-classic')?.equipped).toBe(true);
    expect(feltFlip.find((e) => e.sku === 'felt-emerald')?.equipped).toBe(false);
  });

  it('leaves the catalog untouched for an unknown sku', () => {
    expect(flipCatalog(CATALOG, 'nope')).toBe(CATALOG);
  });
});

describe('StylePanel rendering', () => {
  it('stays hidden until the hello ack arrives (no empty-panel flash)', async () => {
    vi.resetModules();
    const { StylePanel } = await import('../src/lobby/StylePanel.js');
    const socket = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
    } as never as import('socket.io-client').Socket;
    const { renderToStaticMarkup } = await import('react-dom/server');
    expect(renderToStaticMarkup(<StylePanel socket={socket} />)).toBe('');
  });
});
