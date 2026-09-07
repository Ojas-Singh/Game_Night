/**
 * Lobby style picker: card backs and felt themes. Everything is free —
 * tap to equip, the server broadcasts the loadout to the whole room.
 */

import { useMemo } from 'react';
import type { Socket } from 'socket.io-client';
import { useShop } from '../useShop.js';
import { backStyle, feltStyle } from '../cosmetics.js';
import type { ShopCatalogEntry } from '../server-protocol.js';

export function StylePanel({ socket }: { socket: Socket | null }) {
  const shop = useShop(socket);

  const backs = useMemo(() => shop.catalogBySlot('cardBack'), [shop]);
  const felts = useMemo(() => shop.catalogBySlot('feltTheme'), [shop]);
  if (!shop.ready || (backs.length === 0 && felts.length === 0)) return null;

  return (
    <div className="style-panel" aria-label="Table style">
      <div className="style-panel-title">✦ Table style <span className="style-free">free</span></div>
      <ChipRow label="Cards" entries={backs} styleFor={(sku) => backStyle(sku).bg} />
      <ChipRow label="Felt" entries={felts} styleFor={(sku) => feltStyle(sku).center} />
    </div>
  );
}

function ChipRow({
  label,
  entries,
  styleFor,
}: {
  label: string;
  entries: ShopCatalogEntry[];
  styleFor: (sku: string) => string;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="style-row">
      <span className="style-row-label">{label}</span>
      <div className="style-chips">
        {entries.map((entry) => (
          <StyleChip key={entry.sku} entry={entry} styleFor={styleFor} />
        ))}
      </div>
    </div>
  );
}

function StyleChip({
  entry,
  styleFor,
}: {
  entry: ShopCatalogEntry;
  styleFor: (sku: string) => string;
}) {
  return (
    <button
      className={`style-chip ${entry.equipped ? 'equipped' : ''}`}
      style={{ background: styleFor(entry.sku) }}
      title={`${entry.name} — ${entry.description}`}
      aria-pressed={entry.equipped}
    >
      <span>{entry.equipped ? '✓' : ''}</span>
    </button>
  );
}
