/**
 * The cosmetics shop: starter items are free, some unlock by rounds played,
 * paid items open Stripe Checkout. Everything shown is already
 * server-verified — the page renders entitlements, it never asserts them.
 */

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { RoomApi } from '../useRoom.js';
import { useShop } from '../useShop.js';
import { funnel } from '../analytics.js';
import { priceLabel } from '../cosmetics.js';
import type { ShopCatalogEntry } from '../server-protocol.js';

const SLOT_LABELS: Record<ShopCatalogEntry['slot'], string> = {
  cardBack: 'Card backs',
  feltTheme: 'Table felts',
};

export default function ShopPage({ room }: { room: RoomApi }) {
  const shop = useShop(room.socket);

  useEffect(() => {
    if (shop.ready) funnel.shopOpened();
  }, [shop.ready]);

  // Paid purchases redirect to Stripe Checkout and return to
  // /shop?checkout=...; the webhook grants the entitlement out of band.
  useEffect(() => {
    if (shop.checkoutUrl) {
      window.location.href = shop.checkoutUrl;
    }
  }, [shop.checkoutUrl]);

  return (
    <div className="shop-page">
      <header className="shop-header">
        <Link to="/" className="shop-back">← Game Night</Link>
        <h1>Cosmetics Shop</h1>
        {shop.profile && (
          <p className="shop-progress">
            {shop.profile.gamesPlayed} round{shop.profile.gamesPlayed === 1 ? '' : 's'} played — free
            rewards unlock as you play.
          </p>
        )}
      </header>

      {!shop.ready && <p className="shop-note">Opening the shop…</p>}

      {shop.ready && (
        <>
          {(['cardBack', 'feltTheme'] as const).map((slot) => (
            <section key={slot} className="shop-section" aria-label={SLOT_LABELS[slot]}>
              <h2>{SLOT_LABELS[slot]}</h2>
              <div className="shop-grid">
                {shop.catalogBySlot(slot).map((entry) => (
                  <ShopCard
                    key={entry.sku}
                    entry={entry}
                    gamesPlayed={shop.profile?.gamesPlayed ?? 0}
                    stripeEnabled={shop.stripeEnabled}
                    onEquip={() => void shop.equip(entry.sku)}
                    onBuy={() => void shop.purchase(entry.sku)}
                  />
                ))}
              </div>
            </section>
          ))}
          <footer className="shop-footer">
            <p>
              Purchases are one-time and tied to this browser's profile. Sign-in that
              syncs across devices is on the roadmap.
            </p>
            <a href="/privacy">Privacy</a> · <a href="/tos">Terms</a>
          </footer>
        </>
      )}
    </div>
  );
}

function ShopCard({
  entry,
  gamesPlayed,
  stripeEnabled,
  onEquip,
  onBuy,
}: {
  entry: ShopCatalogEntry;
  gamesPlayed: number;
  stripeEnabled: boolean;
  onEquip: () => void;
  onBuy: () => void;
}) {
  const locked = !entry.owned && entry.priceCents === 0 && gamesPlayed < entry.unlockAfterGames;
  const remaining = Math.max(0, entry.unlockAfterGames - gamesPlayed);
  return (
    <article className={`shop-card ${entry.equipped ? 'equipped' : ''} ${locked ? 'locked' : ''}`}>
      <div className={`shop-swatch shop-swatch-${entry.slot}`} data-sku={entry.sku} aria-hidden>
        {entry.slot === 'cardBack' ? '✦' : ''}
      </div>
      <h3>{entry.name}</h3>
      <p className="shop-desc">{entry.description}</p>
      <div className="shop-card-foot">
        <span className="shop-price">{priceLabel(entry.priceCents)}</span>
        {entry.equipped ? (
          <span className="shop-badge equipped">Equipped ✓</span>
        ) : entry.owned ? (
          <button className="shop-btn" onClick={onEquip}>Equip</button>
        ) : locked ? (
          <span className="shop-badge locked">🔒 {remaining} more round{remaining === 1 ? '' : 's'}</span>
        ) : entry.priceCents === 0 ? (
          <button className="shop-btn" onClick={onBuy}>Claim</button>
        ) : stripeEnabled ? (
          <button className="shop-btn buy" onClick={onBuy}>Buy · {priceLabel(entry.priceCents)}</button>
        ) : (
          <span className="shop-badge locked">Store coming soon</span>
        )}
      </div>
    </article>
  );
}
