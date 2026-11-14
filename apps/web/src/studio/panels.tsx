/**
 * The studio's pop-over panels: brush library, colour, layers, fill and
 * symmetry options.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { LAYER_BLENDS, type LayerBlend, type StudioLayer } from '@game-night/shared';
import { BRUSHES, BRUSH_CATEGORIES, ERASERS, type Brush, type BrushCategory } from './engine/brushes.js';
import { StrokeBuffers, StrokeRenderer } from './engine/stroke.js';
import { ctx2d, hexToRgb, rgbToHex } from './engine/tips.js';
import type { CanvasDoc } from './engine/doc.js';
import { Icon } from './icons.js';
import type { ToolState } from './tools.js';

// ---------------------------------------------------------------------------
// Brush library
// ---------------------------------------------------------------------------

const PREVIEW_W = 220, PREVIEW_H = 48;
const previewBuffers = { cur: null as StrokeBuffers | null };

/** A sample stroke drawn with the real brush engine. */
export function BrushPreview({ brush, color, dark }: { brush: Brush; color: string; dark?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = PREVIEW_W * dpr;
    c.height = PREVIEW_H * dpr;
    const g = ctx2d(c);
    g.clearRect(0, 0, c.width, c.height);
    if (!previewBuffers.cur || previewBuffers.cur.raw.width !== c.width) {
      previewBuffers.cur = new StrokeBuffers(c.width, c.height);
    }
    const buf = previewBuffers.cur;
    const size = Math.min(brush.tip === 'soft' || brush.tip === 'wash' ? 22 : 16, Math.max(6, brush.defaultSize));
    const r = new StrokeRenderer(
      { brush: brush.id, color: dark ? '#f2efe8' : color, size, opacity: Math.max(0.6, brush.defaultOpacity), erase: false, seed: 7 },
      buf, dpr,
    );
    const pts: number[] = [];
    const n = 60;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = 14 + t * (PREVIEW_W - 28);
      const y = PREVIEW_H / 2 + Math.sin(t * Math.PI * 2) * (PREVIEW_H * 0.22);
      const p = Math.sin(t * Math.PI) * 0.9 + 0.1;
      pts.push(x, y, p, 0, 0);
    }
    r.push(pts);
    r.finish();
    r.composite(g);
    buf.clear(r.dirty);
  }, [brush, color, dark]);
  return <canvas ref={ref} className="brush-preview" style={{ width: PREVIEW_W, height: PREVIEW_H }} />;
}

export function BrushLibrary({ tools, eraser, onPick }: { tools: ToolState; eraser: boolean; onPick: (id: string) => void }) {
  const current = eraser ? tools.eraser : tools.brush;
  const currentCat = BRUSHES.find((b) => b.id === current)?.category ?? 'Ink';
  const [cat, setCat] = useState<BrushCategory | 'Erasers'>(eraser ? 'Erasers' : currentCat);
  const list = cat === 'Erasers' ? BRUSHES.filter((b) => ERASERS.includes(b.id)) : BRUSHES.filter((b) => b.category === cat);
  return (
    <div className="st-panel st-brushes" role="dialog" aria-label={eraser ? 'Eraser brushes' : 'Brush library'}>
      <div className="st-panel-head">{eraser ? 'Erase with' : 'Brushes'}</div>
      <div className="st-brush-body">
        <nav className="st-brush-cats">
          {(eraser ? (['Erasers', ...BRUSH_CATEGORIES] as const) : BRUSH_CATEGORIES).map((c) => (
            <button key={c} className={c === cat ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>
          ))}
        </nav>
        <ul className="st-brush-list">
          {list.map((b) => (
            <li key={b.id}>
              <button className={b.id === current ? 'on' : ''} onClick={() => onPick(b.id)}>
                <span className="st-brush-name">{b.name}</span>
                <BrushPreview brush={b} color={tools.color} dark />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export const PALETTES: { name: string; colors: string[] }[] = [
  { name: 'Classic', colors: ['#111111', '#4a4a4a', '#9b9b9b', '#ffffff', '#e63946', '#f4a261', '#e9c46a', '#2a9d8f', '#264653', '#457b9d', '#8338ec', '#ff006e'] },
  { name: 'Garden', colors: ['#a8432a', '#d27a2c', '#c9a23a', '#6f7d3c', '#3f6f6c', '#2f4462', '#6a4a78', '#7c2a33', '#6b4a2e', '#e8a54b', '#f7f2e7', '#2e2a2b'] },
  { name: 'Pastel', colors: ['#ffadad', '#ffd6a5', '#fdffb6', '#caffbf', '#9bf6ff', '#a0c4ff', '#bdb2ff', '#ffc6ff', '#fffffc', '#f1c0e8', '#cfbaf0', '#90dbf4'] },
  { name: 'Skin', colors: ['#ffe0c7', '#f8c9a0', '#eab28a', '#d49a6a', '#bb7d52', '#9a6142', '#7b4a32', '#5c3423', '#3d2318', '#f2a88f', '#c97f6b', '#8e5242'] },
  { name: 'Night', colors: ['#0b132b', '#1c2541', '#3a506b', '#5bc0be', '#6fffe9', '#fdfffc', '#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#073b4c', '#8d99ae'] },
];

function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return rgbToHex(f(5) * 255, f(3) * 255, f(1) * 255);
}

function hexToHsv(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = ((h / 6) % 1 + 1) % 1;
  return [h, max ? d / max : 0, max];
}

export function ColorPanel({ tools, onColor }: { tools: ToolState; onColor: (c: string, commit: boolean) => void }) {
  const [hsv, setHsv] = useState<[number, number, number]>(() => hexToHsv(tools.color));
  const [hex, setHex] = useState(tools.color);
  const [palette, setPalette] = useState(0);
  const sv = useRef<HTMLDivElement>(null);
  const hue = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (hsvToHex(...hsv) !== tools.color) setHsv(hexToHsv(tools.color));
    setHex(tools.color);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools.color]);

  const drag = (fn: (u: number, v: number) => void) => (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) =>
      fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
    (e.target as Element).setPointerCapture?.(e.pointerId);
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onColor(hsvToHexRef.current, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const hsvToHexRef = useRef(tools.color);
  const set = (next: [number, number, number]) => {
    setHsv(next);
    const c = hsvToHex(...next);
    hsvToHexRef.current = c;
    onColor(c, false);
  };

  return (
    <div className="st-panel st-color" role="dialog" aria-label="Colour">
      <div className="st-panel-head">
        Colour <span className="st-swatch-big" style={{ background: tools.color }} />
      </div>
      <div
        ref={sv}
        className="st-sv"
        style={{ background: `hsl(${hsv[0] * 360}deg 100% 50%)` }}
        onPointerDown={drag((u, v) => set([hsv[0], u, 1 - v]))}
      >
        <div className="st-sv-white" />
        <div className="st-sv-black" />
        <span className="st-sv-dot" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: tools.color }} />
      </div>
      <div ref={hue} className="st-hue" onPointerDown={drag((u) => set([Math.min(0.999, u), hsv[1], hsv[2]]))}>
        <span className="st-hue-dot" style={{ left: `${hsv[0] * 100}%` }} />
      </div>
      <div className="st-hex-row">
        <label>
          Hex
          <input
            value={hex}
            maxLength={7}
            spellCheck={false}
            onChange={(e) => {
              const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
              setHex(v);
              if (/^#[0-9a-f]{6}$/i.test(v)) onColor(v.toLowerCase(), true);
            }}
          />
        </label>
      </div>
      <div className="st-swatch-title">Recent</div>
      <div className="st-swatches">
        {tools.recent.map((c) => (
          <button key={c} className="st-swatch" style={{ background: c }} title={c} onClick={() => onColor(c, true)} />
        ))}
      </div>
      <div className="st-swatch-title">
        <select value={palette} onChange={(e) => setPalette(Number(e.target.value))} aria-label="Palette">
          {PALETTES.map((p, i) => <option key={p.name} value={i}>{p.name}</option>)}
        </select>
      </div>
      <div className="st-swatches">
        {PALETTES[palette]!.colors.map((c) => (
          <button key={c} className="st-swatch" style={{ background: c }} title={c} onClick={() => onColor(c, true)} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

function LayerThumb({ doc, id, version }: { doc: CanvasDoc; id: string; version: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const l = doc.layer(id);
    if (!c || !l) return;
    const g = ctx2d(c);
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(l.canvas, 0, 0, c.width, c.height);
  }, [doc, id, version]);
  const w = 56, h = Math.max(20, Math.round((56 * doc.height) / doc.width));
  return <canvas ref={ref} width={w} height={h} className="st-layer-thumb" />;
}

export function LayersPanel({
  doc, layers, active, canEdit, version, onSelect, onEdit, onAdd, onClear,
}: {
  doc: CanvasDoc | undefined;
  layers: StudioLayer[];
  active: string | null;
  canEdit: boolean;
  version: number;
  onSelect: (id: string) => void;
  onEdit: (edit: { kind: 'update'; layer: string; patch: Partial<StudioLayer> } | { kind: 'remove'; layer: string } | { kind: 'move'; layer: string; index: number }) => void;
  onAdd: () => void;
  onClear: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  // Throttle thumbnail redraws while people paint.
  const [thumbVersion, setThumbVersion] = useState(version);
  useEffect(() => {
    const t = setTimeout(() => setThumbVersion(version), 400);
    return () => clearTimeout(t);
  }, [version]);
  const top = [...layers].reverse();
  const act = layers.find((l) => l.id === active);
  return (
    <div className="st-panel st-layers" role="dialog" aria-label="Layers">
      <div className="st-panel-head">
        Layers
        {canEdit && (
          <button className="st-icon-btn" onClick={onAdd} title="New layer" aria-label="New layer"><Icon name="plus" size={18} /></button>
        )}
      </div>
      <ul className="st-layer-list">
        {top.map((l) => (
          <li key={l.id} className={l.id === active ? 'on' : ''}>
            <button className="st-layer-main" onClick={() => onSelect(l.id)} onDoubleClick={() => canEdit && setRenaming(l.id)}>
              {doc && <LayerThumb doc={doc} id={l.id} version={thumbVersion} />}
              {renaming === l.id ? (
                <input
                  autoFocus
                  defaultValue={l.name}
                  maxLength={32}
                  onBlur={(e) => { setRenaming(null); onEdit({ kind: 'update', layer: l.id, patch: { name: e.target.value } }); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur(); }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="st-layer-name">{l.name}</span>
              )}
              {l.blend !== 'normal' && <span className="st-layer-blend">{l.blend}</span>}
            </button>
            <button
              className="st-icon-btn"
              disabled={!canEdit}
              onClick={() => onEdit({ kind: 'update', layer: l.id, patch: { visible: !l.visible } })}
              aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
              title={l.visible ? 'Hide' : 'Show'}
            >
              <Icon name={l.visible ? 'eye' : 'eyeOff'} size={18} />
            </button>
          </li>
        ))}
      </ul>
      {act && canEdit && (
        <div className="st-layer-tools">
          <label className="st-range">
            <span>Opacity</span>
            <input type="range" min={0} max={100} value={Math.round(act.opacity * 100)}
              onChange={(e) => onEdit({ kind: 'update', layer: act.id, patch: { opacity: Number(e.target.value) / 100 } })} />
            <output>{Math.round(act.opacity * 100)}%</output>
          </label>
          <label className="st-select">
            <span>Blend</span>
            <select value={act.blend} onChange={(e) => onEdit({ kind: 'update', layer: act.id, patch: { blend: e.target.value as LayerBlend } })}>
              {LAYER_BLENDS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </label>
          <div className="st-layer-actions">
            <button onClick={() => onEdit({ kind: 'move', layer: act.id, index: layers.indexOf(act) + 1 })} title="Move up"><Icon name="up" size={18} /></button>
            <button onClick={() => onEdit({ kind: 'move', layer: act.id, index: Math.max(0, layers.indexOf(act) - 1) })} title="Move down"><Icon name="down" size={18} /></button>
            <button onClick={() => setRenaming(act.id)}>Rename</button>
            <button onClick={() => onClear(act.id)}>Clear</button>
            <button className="danger" disabled={layers.length <= 1}
              onClick={() => window.confirm(`Delete ${act.name}? Everyone's strokes on it go too.`) && onEdit({ kind: 'remove', layer: act.id })}
              title="Delete layer"><Icon name="trash" size={18} /></button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fill and symmetry
// ---------------------------------------------------------------------------

export function FillPanel({ tools, hasLines, onChange }: { tools: ToolState; hasLines: boolean; onChange: (f: Partial<ToolState['fill']>) => void }) {
  const f = tools.fill;
  return (
    <div className="st-panel st-fill" role="dialog" aria-label="Fill options">
      <div className="st-panel-head">Fill</div>
      <div className="st-seg">
        <button className={f.mode === 'lines' ? 'on' : ''} disabled={!hasLines} onClick={() => onChange({ mode: 'lines' })}
          title={hasLines ? 'Stop at the picture’s lines' : 'Needs a picture with lines'}>Inside the lines</button>
        <button className={f.mode === 'color' ? 'on' : ''} onClick={() => onChange({ mode: 'color' })}>Same colour</button>
      </div>
      {f.mode === 'color' && (
        <div className="st-seg">
          <button className={f.sample === 'all' ? 'on' : ''} onClick={() => onChange({ sample: 'all' })}>Everything</button>
          <button className={f.sample === 'layer' ? 'on' : ''} onClick={() => onChange({ sample: 'layer' })}>This layer</button>
        </div>
      )}
      <label className="st-range">
        <span>Tolerance</span>
        <input type="range" min={1} max={90} value={Math.round(f.tolerance * 100)} onChange={(e) => onChange({ tolerance: Number(e.target.value) / 100 })} />
        <output>{Math.round(f.tolerance * 100)}%</output>
      </label>
      <label className="st-range">
        <span>Spread under lines</span>
        <input type="range" min={0} max={6} value={f.grow} onChange={(e) => onChange({ grow: Number(e.target.value) })} />
        <output>{f.grow}px</output>
      </label>
    </div>
  );
}

export function SymmetryPanel({ tools, width, height, onChange }: {
  tools: ToolState; width: number; height: number; onChange: (sym: ToolState['sym']) => void;
}) {
  const sym = tools.sym;
  const kinds = [
    { id: null, name: 'Off' },
    { id: 'vertical', name: 'Mirror' },
    { id: 'horizontal', name: 'Flip' },
    { id: 'quadrant', name: 'Four' },
    { id: 'radial', name: 'Radial' },
  ] as const;
  return (
    <div className="st-panel st-sym" role="dialog" aria-label="Symmetry">
      <div className="st-panel-head">Symmetry</div>
      <div className="st-seg wrap">
        {kinds.map((k) => (
          <button key={k.name} className={(sym?.kind ?? null) === k.id ? 'on' : ''}
            onClick={() => onChange(k.id ? { kind: k.id, count: sym?.count ?? 8, cx: width / 2, cy: height / 2 } : null)}>
            {k.name}
          </button>
        ))}
      </div>
      {sym?.kind === 'radial' && (
        <label className="st-range">
          <span>Copies</span>
          <input type="range" min={2} max={16} value={sym.count} onChange={(e) => onChange({ ...sym, count: Number(e.target.value) })} />
          <output>{sym.count}</output>
        </label>
      )}
    </div>
  );
}

export function PenPanel({ tools, onChange }: { tools: ToolState; onChange: (p: Partial<ToolState>) => void }) {
  const curve = useMemo(() => {
    const pts: string[] = [];
    for (let i = 0; i <= 20; i++) {
      const x = i / 20;
      pts.push(`${(x * 100).toFixed(1)},${(100 - Math.pow(x, tools.pressureGamma) * 100).toFixed(1)}`);
    }
    return pts.join(' ');
  }, [tools.pressureGamma]);
  return (
    <div className="st-panel st-pen" role="dialog" aria-label="Pen settings">
      <div className="st-panel-head">Pen &amp; touch</div>
      <div className="st-curve">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden><polyline points={curve} /></svg>
        <span>pressure → ink</span>
      </div>
      <label className="st-range">
        <span>Pen feel</span>
        <input type="range" min={40} max={250} value={Math.round(tools.pressureGamma * 100)}
          onChange={(e) => onChange({ pressureGamma: Number(e.target.value) / 100 })} />
        <output>{tools.pressureGamma < 0.9 ? 'Soft' : tools.pressureGamma > 1.1 ? 'Firm' : 'Even'}</output>
      </label>
      <label className="st-range">
        <span>Stabiliser</span>
        <input type="range" min={0} max={80} value={Math.round(tools.stabilizer * 100)}
          onChange={(e) => onChange({ stabilizer: Number(e.target.value) / 100 })} />
        <output>{Math.round(tools.stabilizer * 100)}</output>
      </label>
      <label className="st-check">
        <input type="checkbox" checked={tools.quickShape} onChange={(e) => onChange({ quickShape: e.target.checked })} />
        Hold at the end of a stroke to make a straight line or an ellipse
      </label>
      <label className="st-check">
        <input type="checkbox" checked={tools.fingerPaint} onChange={(e) => onChange({ fingerPaint: e.target.checked })} />
        Fingers draw (off: fingers only move the canvas)
      </label>
      <p className="st-hint">Pen eraser end erases · barrel button or Alt picks a colour · two-finger tap undoes, three-finger tap redoes.</p>
    </div>
  );
}
