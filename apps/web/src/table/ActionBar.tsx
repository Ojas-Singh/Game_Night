import { useState } from 'react';
export default function ActionBar({ actions }: { actions: { id: string; label: string; run: () => Promise<{ ok: boolean; error?: string }> }[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div className="launch-row">{actions.map(a => <button key={a.id} disabled={busy} onClick={async () => {
    setBusy(true); setError('');
    try { const result = await a.run(); if (!result.ok) setError(result.error || 'Action failed'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }}>{a.label}</button>)}{error && <p role="alert">{error}</p>}</div>;
}
