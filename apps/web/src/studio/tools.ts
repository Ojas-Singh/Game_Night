/**
 * This person's tool settings: the brush and eraser picked, size and
 * opacity per brush (as in Procreate), colour, pen feel and fill options.
 * Remembered in the browser between visits.
 */

import { useCallback, useEffect, useState } from 'react';
import type { StrokeSymmetry } from '@game-night/shared';
import { BRUSHES, brushById } from './engine/brushes.js';
import type { FillOptions } from './engine/fill.js';

export type Tool = 'brush' | 'eraser' | 'fill' | 'picker' | 'hand';

export interface ToolState {
  tool: Tool;
  brush: string;
  eraser: string;
  /** Size and opacity per brush id (eraser entries are prefixed "e:"). */
  sizes: Record<string, number>;
  opacities: Record<string, number>;
  color: string;
  recent: string[];
  /** Extra smoothing on top of the brush's own (0..1). */
  stabilizer: number;
  /** Pen feel: pressure is raised to this power (below 1 soft, above 1 firm). */
  pressureGamma: number;
  /** Fingers draw too (off once a pen has been seen: palm rejection). */
  fingerPaint: boolean;
  /** Snap to a straight line or ellipse when the pen holds still. */
  quickShape: boolean;
  sym: StrokeSymmetry | null;
  fill: FillOptions & { sample: 'all' | 'layer' };
}

const KEY = 'gn:studio-tools';

const DEFAULTS: ToolState = {
  tool: 'brush',
  brush: 'ink-pen',
  eraser: 'soft-air',
  sizes: {},
  opacities: {},
  color: '#1f2a44',
  recent: ['#1f2a44', '#e4572e', '#f3a712', '#29bf12', '#2e86de', '#8e44ad', '#ffffff', '#111111'],
  stabilizer: 0.15,
  pressureGamma: 1,
  fingerPaint: true,
  quickShape: true,
  sym: null,
  fill: { mode: 'color', tolerance: 0.12, grow: 1, sample: 'all' },
};

function load(): ToolState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<ToolState>;
    return { ...DEFAULTS, ...v, fill: { ...DEFAULTS.fill, ...(v.fill ?? {}) }, tool: v.tool === 'hand' ? 'brush' : v.tool ?? 'brush' };
  } catch {
    return DEFAULTS;
  }
}

export function useTools(): [ToolState, (patch: Partial<ToolState> | ((t: ToolState) => Partial<ToolState>)) => void] {
  const [tools, setTools] = useState<ToolState>(load);
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify(tools)); } catch { /* private mode */ }
    }, 300);
    return () => clearTimeout(t);
  }, [tools]);
  const update = useCallback((patch: Partial<ToolState> | ((t: ToolState) => Partial<ToolState>)) => {
    setTools((t) => ({ ...t, ...(typeof patch === 'function' ? patch(t) : patch) }));
  }, []);
  return [tools, update];
}

/** The brush the current tool paints with. */
export function activeBrushId(t: ToolState): string {
  return t.tool === 'eraser' ? t.eraser : t.brush;
}

function sizeKey(t: ToolState): string {
  return t.tool === 'eraser' ? `e:${t.eraser}` : t.brush;
}

export function currentSize(t: ToolState): number {
  return t.sizes[sizeKey(t)] ?? brushById(activeBrushId(t)).defaultSize * (t.tool === 'eraser' ? 2 : 1);
}

export function currentOpacity(t: ToolState): number {
  return t.opacities[sizeKey(t)] ?? (t.tool === 'eraser' ? 1 : brushById(activeBrushId(t)).defaultOpacity);
}

export function withSize(t: ToolState, size: number): Partial<ToolState> {
  return { sizes: { ...t.sizes, [sizeKey(t)]: Math.round(size * 10) / 10 } };
}

export function withOpacity(t: ToolState, opacity: number): Partial<ToolState> {
  return { opacities: { ...t.opacities, [sizeKey(t)]: Math.round(opacity * 100) / 100 } };
}

export function withColor(t: ToolState, color: string): Partial<ToolState> {
  const recent = [color, ...t.recent.filter((c) => c !== color)].slice(0, 16);
  return { color, recent };
}

export const BRUSH_IDS = new Set(BRUSHES.map((b) => b.id));
