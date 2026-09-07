/**
 * Shop client state: a bearer profile token in localStorage, the server-owned
 * catalog/profile snapshot over the app-wide socket, and equip/purchase
 * actions. Entitlements are always server-verified — the client only renders
 * what the server already confirmed.
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
  stripeEnabled: boolean;
  /** Checkout URL from the last paid purchase, if any (client redirects). */
  checkoutUrl: string | null;
}

export interface ShopApi extends ShopState {
  refresh: () => void;
  purchase: (sku: string) => Promise<{ ok: boolean; checkoutUrl?: string; error?: string }>;
  equip: (sku: string) => Promise<{ ok: boolean; error?: string }>;
  catalogBySlot: (slot: ShopCatalogEntry['slot']) => ShopCatalogEntry[];
}

export function useShop(socket: Socket | null): ShopApi {
  const [state, setState] = useState<ShopState>({
    ready: false,
    profile: null,
    catalog: [],
    stripeEnabled: false,
    checkoutUrl: null,
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
            stripeEnabled: res.stripeEnabled,
          }));
        },
      );
    };

    hello();
    socket.on('connect', hello);
    socket.on('shop:granted', hello);
    return () => {
      alive = false;
      socket.off('connect', hello);
      socket.off('shop:granted', hello);
    };
  }, [socket]);

  const purchase = useCallback(
    (sku: string): Promise<{ ok: boolean; checkoutUrl?: string; error?: string }> =>
      new Promise((resolve) => {
        if (!socket) {
          resolve({ ok: false, error: 'offline' });
          return;
        }
        socket.emit('shop:purchase', { sku }, (res: { ok: boolean; granted?: boolean; checkoutUrl?: string; error?: string }) => {
          if (res.ok) {
            // Re-sync entitlements regardless of grant path (webhook grants
            // land later; the hello refresh on next load catches them too).
            socket.emit(
              'shop:hello',
              { token: loadShopToken() },
              (fresh: ShopHelloResult) => {
                if (fresh.ok) {
                  setState((cur) => ({
                    ...cur,
                    profile: fresh.profile,
                    catalog: fresh.catalog,
                    stripeEnabled: fresh.stripeEnabled,
                    checkoutUrl: res.checkoutUrl ?? null,
                  }));
                }
                resolve(res);
              },
            );
          } else {
            resolve(res);
          }
        });
      }),
    [socket],
  );

  const equip = useCallback(
    (sku: string): Promise<{ ok: boolean; error?: string }> =>
      new Promise((resolve) => {
        if (!socket) {
          resolve({ ok: false, error: 'offline' });
          return;
        }
        socket.emit('shop:equip', { sku }, (res: { ok: boolean; error?: string }) => {
          if (res.ok) {
            // Optimistic catalog flip; server broadcast re-syncs the lobby.
            setState((cur) => ({
              ...cur,
              catalog: cur.catalog.map((entry) => ({
                ...entry,
                equipped: entry.sku === sku,
              })),
            }));
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
        setState((cur) => ({
          ...cur,
          ready: true,
          profile: res.profile,
          catalog: res.catalog,
          stripeEnabled: res.stripeEnabled,
        }));
      }
    });
  }, [socket]);

  return { ...state, refresh, purchase, equip, catalogBySlot };
}
