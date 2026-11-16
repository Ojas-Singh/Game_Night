/**
 * The host's studio setup: mode, picture, paper and canvas size. Used in
 * the lobby before opening the studio and inside the studio afterwards.
 */

import { useRef, useState } from 'react';
import { PAPERS, type PaperId, type StudioImage, type StudioMode, type StudioSetup } from '@game-night/shared';
import { PAPER_INFO } from './engine/render.js';
import { PAGE_KINDS, makePage, preparePicture, type PageKind, type PreparedPicture } from './pictures.js';
import { uploadAsset } from './client.js';
import { Icon } from './icons.js';

export interface SetupValue {
  mode: StudioMode;
  paper: PaperId;
  width: number;
  height: number;
  image: StudioImage | null;
}

export const DEFAULT_SETUP: SetupValue = { mode: 'together', paper: 'white', width: 1600, height: 1200, image: null };

export const MODE_INFO: Record<StudioMode, { name: string; short: string; blurb: string }> = {
  together: { name: 'Draw together', short: 'Free canvas', blurb: 'One canvas, everyone’s brushes on it at once.' },
  colouring: { name: 'Colour together', short: 'Colour a picture', blurb: 'Pick a picture; fill and paint inside its lines as a team.' },
  'side-by-side': { name: 'Side by side', short: 'Side by side', blurb: 'Same picture, a canvas each — compare at the end.' },
};

const SIZES = [
  { name: 'Landscape', w: 1600, h: 1200 },
  { name: 'Portrait', w: 1200, h: 1600 },
  { name: 'Square', w: 1500, h: 1500 },
  { name: 'Wide', w: 1920, h: 1080 },
  { name: 'Large', w: 2400, h: 1800 },
];

function ModeArt({ mode }: { mode: StudioMode }) {
  if (mode === 'together') {
    return (
      <svg viewBox="0 0 64 44" aria-hidden>
        <rect x="4" y="4" width="56" height="36" rx="4" className="paper" />
        <path d="M12 30c6-12 12 6 18-6s10 4 14-4" className="s1" />
        <path d="M14 14c8 4 14-4 22 2s10 8 16 2" className="s2" />
      </svg>
    );
  }
  if (mode === 'colouring') {
    return (
      <svg viewBox="0 0 64 44" aria-hidden>
        <rect x="4" y="4" width="56" height="36" rx="4" className="paper" />
        <circle cx="32" cy="22" r="12" className="fill1" />
        <path d="M32 10v24M20 22h24" className="line" />
        <circle cx="32" cy="22" r="12" className="line" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 44" aria-hidden>
      <rect x="3" y="8" width="27" height="28" rx="3" className="paper" />
      <rect x="34" y="8" width="27" height="28" rx="3" className="paper" />
      <circle cx="16.5" cy="22" r="7" className="fill1" />
      <circle cx="47.5" cy="22" r="7" className="fill2" />
      <circle cx="16.5" cy="22" r="7" className="line" />
      <circle cx="47.5" cy="22" r="7" className="line" />
    </svg>
  );
}

export default function SetupPanel({
  roomId, value, onChange, live = false, compact = false,
}: {
  roomId: string;
  value: SetupValue;
  /** Apply a change (in the lobby: local; in the studio: sent to the server). */
  onChange: (patch: StudioSetup) => void | Promise<unknown>;
  /** Settings of an open studio: size and mode changes start a fresh canvas. */
  live?: boolean;
  compact?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lineArt, setLineArt] = useState(true);
  const [seed, setSeed] = useState(() => (Math.random() * 1e9) | 0);

  const confirmWipe = (what: string) => !live || window.confirm(`${what} starts a fresh canvas for everyone. Go ahead?`);

  const usePicture = async (pic: PreparedPicture, placement: StudioImage['placement'], resize: boolean) => {
    const asset = await uploadAsset(roomId, pic.blob);
    const image: StudioImage = { asset, width: pic.width, height: pic.height, placement, opacity: placement === 'trace' ? 0.35 : 1 };
    const patch: StudioSetup = { image };
    // Fit the canvas to the picture (its shape, at least 1200 on the long side).
    if (resize) {
      const k = Math.max(1, 1200 / Math.max(pic.width, pic.height));
      patch.width = Math.round(pic.width * k);
      patch.height = Math.round(pic.height * k);
    }
    await onChange(patch);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy('Uploading…');
    try {
      const pic = await preparePicture(file, { lineArt });
      const sameSize = Math.abs(pic.width / pic.height - value.width / value.height) < 0.02;
      const resize = !sameSize && confirmWipe('Fitting the canvas to this picture');
      await usePicture(pic, lineArt ? 'lines' : 'trace', resize);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not use that picture');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onPage = async (kind: PageKind, nextSeed = seed) => {
    setError(null);
    setBusy('Drawing a page…');
    try {
      const pic = await makePage(kind, nextSeed, value.width, value.height);
      await usePicture(pic, 'lines', false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not make a page');
    } finally {
      setBusy(null);
    }
  };

  const img = value.image;

  return (
    <div className={`st-setup ${compact ? 'compact' : ''}`}>
      <section>
        <h3>Mode</h3>
        <div className="st-modes">
          {(Object.keys(MODE_INFO) as StudioMode[]).map((m) => (
            <button
              key={m}
              className={`st-mode ${value.mode === m ? 'on' : ''}`}
              onClick={() => {
                if (m === value.mode) return;
                const sharedChange = (m === 'side-by-side') !== (value.mode === 'side-by-side');
                if (sharedChange && !confirmWipe('Switching between shared and separate canvases')) return;
                void onChange({ mode: m });
              }}
              aria-pressed={value.mode === m}
            >
              <ModeArt mode={m} />
              <strong>{MODE_INFO[m].name}</strong>
              <span>{MODE_INFO[m].blurb}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Picture {value.mode === 'colouring' && !img && <em className="st-need">pick one to colour</em>}</h3>
        <div className="st-picture-row">
          <div className="st-picture-thumb">
            {img ? <img src={`/api/studio/${encodeURIComponent(roomId)}/asset/${img.asset}`} alt="Current picture" /> : <span>No picture</span>}
          </div>
          <div className="st-picture-actions">
            <button className="st-btn" onClick={() => fileRef.current?.click()} disabled={!!busy}>
              <Icon name="image" size={18} /> Upload…
            </button>
            <label className="st-check small">
              <input type="checkbox" checked={lineArt} onChange={(e) => setLineArt(e.target.checked)} />
              Line art (white turns see-through)
            </label>
            <div className="st-page-row">
              {PAGE_KINDS.map((p) => (
                <button key={p.id} className="st-btn ghost" disabled={!!busy} onClick={() => void onPage(p.id)}>{p.name}</button>
              ))}
              <button
                className="st-btn ghost icon"
                title="Shuffle the generated pages"
                aria-label="Shuffle the generated pages"
                onClick={() => setSeed((Math.random() * 1e9) | 0)}
              >
                <Icon name="shuffle" size={16} />
              </button>
            </div>
            {img && (
              <div className="st-seg">
                <button className={img.placement === 'lines' ? 'on' : ''}
                  onClick={() => void onChange({ image: { ...img, placement: 'lines', opacity: 1 } })}>Lines on top</button>
                <button className={img.placement === 'trace' ? 'on' : ''} disabled={value.mode === 'colouring'}
                  onClick={() => void onChange({ image: { ...img, placement: 'trace', opacity: 0.35 } })}>Trace underneath</button>
                <button onClick={() => void onChange({ image: null })}>Remove</button>
              </div>
            )}
            {img?.placement === 'trace' && (
              <label className="st-range">
                <span>Fade</span>
                <input type="range" min={5} max={100} value={Math.round(img.opacity * 100)}
                  onChange={(e) => void onChange({ image: { ...img, opacity: Number(e.target.value) / 100 } })} />
              </label>
            )}
          </div>
        </div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => void onFile(e.target.files?.[0])} />
        {busy && <p className="st-note">{busy}</p>}
        {error && <p className="st-note error">{error}</p>}
      </section>

      <section>
        <h3>Paper</h3>
        <div className="st-papers">
          {PAPERS.map((p) => (
            <button key={p} className={`st-paper ${value.paper === p ? 'on' : ''}`} onClick={() => void onChange({ paper: p })} title={PAPER_INFO[p].name}>
              <span className={`st-paper-chip paper-${p}`} style={{ background: PAPER_INFO[p].color }} />
              <small>{PAPER_INFO[p].name}</small>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Canvas</h3>
        <div className="st-sizes">
          {SIZES.map((s) => (
            <button key={s.name} className={`st-btn ghost ${value.width === s.w && value.height === s.h ? 'on' : ''}`}
              onClick={() => (value.width !== s.w || value.height !== s.h) && confirmWipe('Changing the canvas size') && void onChange({ width: s.w, height: s.h })}>
              {s.name} <small>{s.w}×{s.h}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
