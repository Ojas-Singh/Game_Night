/** Cosmetic sku → style mapping and price labels. */

import { describe, expect, it } from 'vitest';
import { backStyle, feltStyle, priceLabel } from '../src/cosmetics.js';

describe('cosmetics styles', () => {
  it('falls back to the classic defaults for unknown or missing skus', () => {
    expect(backStyle('back-nonexistent')).toEqual(backStyle(undefined));
    expect(backStyle(undefined).glyph).toBe('✦');
    expect(feltStyle('nope').domClass).toBe('emerald');
  });

  it('maps each known sku to a distinct style', () => {
    const backs = ['back-classic', 'back-verdant', 'back-midnight', 'back-sunburst', 'back-royale'];
    const styles = new Set(backs.map((sku) => backStyle(sku).bg));
    expect(styles.size).toBe(backs.length);
    const felts = ['felt-emerald', 'felt-slate', 'felt-azure', 'felt-crimson'];
    const felts2 = new Set(felts.map((sku) => feltStyle(sku).domClass));
    expect(felts2.size).toBe(felts.length);
  });

  it('formats price labels', () => {
    expect(priceLabel(0)).toBe('Free');
    expect(priceLabel(299)).toBe('$2.99');
    expect(priceLabel(999)).toBe('$9.99');
  });
});
