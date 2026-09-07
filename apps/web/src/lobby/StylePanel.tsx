/**
 * Lobby style picker: card backs and felt themes. Tap a chip to equip it —
 * the server validates and broadcasts the new loadout to the whole room.
 */

import { useMemo, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { useShop } from '../useShop.js';
import { backStyle, feltStyle } from '../cosmetics.js';
import type { ShopCatalogEntry } from '../server-protocol.js';

export function StylePanel({ socket }: { socket: Socket | null }) {
  const shop = useShop(socket);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const backs = useMemo(() => shop.catalogBySlot('cardBack'), [shop]);
  const felts = useMemo(() => shop.catalogBySlot('feltTheme'), [shop]);
  if (!shop.ready || (backs.length === 0 && felts.length === 0)) return null;

  const pick = (entry: ShopCatalogEntry): void => {
    if (entry.equipped || pending) return;
    setPending(entry.sku);
    setError(null);
    void shop.equip(entry.sku).then((res) => {
      setPending(null);
      if (!res.ok) setError('Could not save that style — try again.');
    });
  };

  return (
    <div className="style-panel" aria-label="Table style">
      <div className="style-panel-title">✦ Table style</div>
      <ChipRow label="Cards" entries={backs} pending={pending} onPick={pick} styleFor={(sku) => backStyle(sku).bg} />
      <ChipRow label="Felt" entries={felts} pending={pending} onPick={pick} styleFor={(sku) => feltStyle(sku).center} />
      {error && <p className="style-error" role="alert">{error}</p>}
    </div>
  );
}

function ChipRow({
  label,
  entries,
  pending,
  onPick,
  styleFor,
}: {
  label: string;
  entries: ShopCatalogEntry[];
  pending: string | null;
  onPick: (entry: ShopCatalogEntry) => void;
  styleFor: (sku: string) => string;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="style-row">
      <span className="style-row-label">{label}</span>
      <div className="style-chips">
        {entries.map((entry) => (
          <StyleChip key={entry.sku} entry={entry} pending={pending === entry.sku} onPick={onPick} styleFor={styleFor} />
        ))}
      </div>
    </div>
  );
}

function StyleChip({
  entry,
  pending,
  onPick,
  styleFor,
}: {
  entry: ShopCatalogEntry;
  pending: boolean;
  onPick: (entry: ShopCatalogEntry) => void;
  styleFor: (sku: string) => string;
}) {
  return (
    <button
      className={`style-chip ${entry.equipped ? 'equipped' : ''} ${pending ? 'pending' : ''}`}
      style={{ background: styleFor(entry.sku) }}
      title={`${entry.name} — ${entry.description}`}
      aria-pressed={entry.equipped}
      aria-label={`Equip ${entry.name}`}
      disabled={pending}
      onClick={() => onPick(entry)}
    >
      <span>{entry.equipped ? '✓' : ''}</span>
    </button>
  );
}
