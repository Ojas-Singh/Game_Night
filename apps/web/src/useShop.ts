/**
 * Cosmetics client state: a bearer profile token in localStorage, the
 * server-owned catalog/profile snapshot over the app-wide socket, and an
 * equip action. Everything is FREE — no purchase flow. The server remains
 * the source of truth for the catalog.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { ShopHelloResult, ShopCatalogEntry } from './server-protocol.js';

const TOKEN_KEY = 'game-night:shop-token';

export function loadShopToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveShopToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode */
  }
}

export interface ShopState {
  ready: boolean;
  profile: ShopHelloResult['profile'] | null;
  catalog: ShopCatalogEntry[];
}

export interface ShopApi extends ShopState {
  refresh: () => void;
  equip: (sku: string) => Promise<{ ok: boolean; error?: string }>;
  catalogBySlot: (slot: ShopCatalogEntry['slot']) => ShopCatalogEntry[];
}

/**
 * Optimistic equip flip: the picked sku gets the ✓ and the sku it replaced
 * in the SAME slot loses it. The other slot's equipped chip is untouched —
 * a card back and a felt are equipped independently.
 */
export function flipCatalog(catalog: ShopCatalogEntry[], sku: string): ShopCatalogEntry[] {
  const slot = catalog.find((entry) => entry.sku === sku)?.slot;
  if (!slot) return catalog;
  return catalog.map((entry) => ({
    ...entry,
    equipped: entry.sku === sku || (entry.slot !== slot && entry.equipped),
  }));
}

export function useShop(socket: Socket | null): ShopApi {
  const [state, setState] = useState<ShopState>({
    ready: false,
    profile: null,
    catalog: [],
  });

  useEffect(() => {
    if (!socket) return;
    let alive = true;

    const hello = (): void => {
      socket.emit(
        'shop:hello',
        { token: loadShopToken() },
        (res: ShopHelloResult) => {
          if (!alive) return;
          if (res.ok && res.token) saveShopToken(res.token);
          setState((cur) => ({
            ...cur,
            ready: res.ok,
            profile: res.ok ? res.profile : cur.profile,
            catalog: res.ok ? res.catalog : cur.catalog,
          }));
        },
      );
    };

    hello();
    socket.on('connect', hello);
    return () => {
      alive = false;
      socket.off('connect', hello);
    };
  }, [socket]);

  const equip = useCallback(
    (sku: string): Promise<{ ok: boolean; error?: string }> =>
      new Promise((resolve) => {
        if (!socket) {
          resolve({ ok: false, error: 'offline' });
          return;
        }
        socket.emit('shop:equip', { sku }, (res: { ok: boolean; error?: string }) => {
          if (res.ok) {
            setState((cur) => ({ ...cur, catalog: flipCatalog(cur.catalog, sku) }));
          }
          resolve(res);
        });
      }),
    [socket],
  );

  const catalogBySlot = useCallback(
    (slot: ShopCatalogEntry['slot']): ShopCatalogEntry[] =>
      state.catalog.filter((entry) => entry.slot === slot),
    [state.catalog],
  );

  const refresh = useCallback((): void => {
    if (!socket) return;
    socket.emit('shop:hello', { token: loadShopToken() }, (res: ShopHelloResult) => {
      if (res.ok) {
        setState({ ready: true, profile: res.profile, catalog: res.catalog });
      }
    });
  }, [socket]);

  return { ...state, refresh, equip, catalogBySlot };
}
