/**
 * The drawing surface: shows the focused canvas and turns pen, mouse and
 * touch input into strokes, fills and colour picks.
 *
 * Pen input uses every coalesced sample (Wacom tablets report ~200 Hz),
 * pressure through the person's curve, and tilt. The pen's eraser end
 * erases and its barrel button picks a colour. Two fingers pan, pinch and
 * rotate; a two-finger tap undoes and a three-finger tap redoes.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { SHARED_CANVAS, type StrokeSymmetry } from '@game-night/shared';
import type { StudioClient } from './client.js';
import { newId } from './client.js';
import { brushById } from './engine/brushes.js';
import { compose, paperCanvas } from './engine/render.js';
import { computeFill } from './engine/fill.js';
import { ctx2d, makeCanvas, rgbToHex } from './engine/tips.js';
import type { StrokeRenderer } from './engine/stroke.js';
import { activeBrushId, currentOpacity, currentSize, type ToolState } from './tools.js';

export interface View { x: number; y: number; zoom: number; rot: number }

export interface SurfaceHandle {
  fit: () => void;
  zoomBy: (k: number) => void;
  resetRotation: () => void;
  view: () => View;
}

interface Props {
  client: StudioClient;
  tools: ToolState;
  layer: string | null;
  names: Record<string, { name: string; color: string }>;
  onPick: (color: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Tell the parent the pen showed up (to switch off finger painting). */
  onPenSeen: () => void;
  onZoom?: (zoom: number) => void;
  /** Space is held: drag pans. */
  panKey: boolean;
}

interface Stroke {
  pointerId: number;
  renderer: StrokeRenderer;
  points: number[];
  /** Smoothed pen position. */
  sx: number; sy: number; sp: number;
  lastT: number;
  stream: number;
  /** Raw path for QuickShape. */
  raw: Array<[number, number, number]>;
  stillSince: number;
  stillX: number; stillY: number;
  shape: 'line' | 'ellipse' | null;
  liveAt: number;
  erase: boolean;
  sym: StrokeSymmetry | undefined;
}

interface Gesture {
  ids: number[];
  startDist: number;
  startAngle: number;
  startMid: [number, number];
  startView: View;
  startedAt: number;
  moved: number;
  maxTouches: number;
}

const BG = '#2a2b30';

const Surface = forwardRef<SurfaceHandle, Props>(function Surface(props, ref) {
  const { client } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const view = useRef<View>({ x: 0, y: 0, zoom: 1, rot: 0 });
  const fitted = useRef<string>('');
  const userMoved = useRef(false);
  const dirty = useRef(true);
  const stroke = useRef<Stroke | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>());
  const gesture = useRef<Gesture | null>(null);
  const pan = useRef<{ id: number; x: number; y: number; view: View } | null>(null);
  const hover = useRef<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false });
  const penSeen = useRef(false);
  const cursorSent = useRef(0);
  const picking = useRef<number | null>(null);

  const size = () => {
    const c = canvasRef.current!;
    return { w: c.clientWidth, h: c.clientHeight };
  };

  // --- view helpers --------------------------------------------------------

  const fit = useCallback(() => {
    const st = client.state;
    if (!st || !canvasRef.current) return;
    const { w, h } = size();
    // Leave room for the toolbars: top bar, side bar, people along the bottom.
    const phone = w <= 720;
    const top = phone ? 54 : 60, bottom = phone ? 56 : 64, left = phone ? 50 : 70, right = phone ? 8 : 24;
    const zoom = Math.min((w - left - right) / st.width, (h - top - bottom) / st.height);
    view.current = {
      zoom, rot: 0,
      x: left + (w - left - right - st.width * zoom) / 2,
      y: top + (h - top - bottom - st.height * zoom) / 2,
    };
    userMoved.current = false;
    dirty.current = true;
    propsRef.current.onZoom?.(zoom);
  }, [client]);

  /** Screen point → canvas point. */
  const toDoc = (sx: number, sy: number): [number, number] => {
    const v = view.current;
    const dx = sx - v.x, dy = sy - v.y;
    const c = Math.cos(-v.rot), s = Math.sin(-v.rot);
    return [(dx * c - dy * s) / v.zoom, (dx * s + dy * c) / v.zoom];
  };

  /** Canvas point → screen point. */
  const toScreen = (x: number, y: number): [number, number] => {
    const v = view.current;
    const c = Math.cos(v.rot), s = Math.sin(v.rot);
    return [v.x + (x * c - y * s) * v.zoom, v.y + (x * s + y * c) * v.zoom];
  };

  /** Zoom by k keeping the screen point (px, py) fixed. */
  const zoomAt = (k: number, px: number, py: number) => {
    const v = view.current;
    const zoom = Math.min(64, Math.max(0.05, v.zoom * k));
    const [dx, dy] = toDoc(px, py);
    view.current = { ...v, zoom };
    const [nx, ny] = toScreen(dx, dy);
    view.current.x += px - nx;
    view.current.y += py - ny;
    userMoved.current = true;
    dirty.current = true;
    propsRef.current.onZoom?.(zoom);
  };

  useImperativeHandle(ref, () => ({
    fit,
    zoomBy: (k) => { const { w, h } = size(); zoomAt(k, w / 2, h / 2); },
    resetRotation: () => {
      const { w, h } = size();
      const [cx, cy] = toDoc(w / 2, h / 2);
      view.current.rot = 0;
      const [nx, ny] = toScreen(cx, cy);
      view.current.x += w / 2 - nx;
      view.current.y += h / 2 - ny;
      dirty.current = true;
    },
    view: () => view.current,
  }), [fit]);

  // --- drawing loop --------------------------------------------------------

  useEffect(() => {
    let raf = 0;
    let seen = -1;
    let lastSweep = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const c = canvasRef.current;
      if (!c) return;
      if (t - lastSweep > 1000) { client.sweep(); lastSweep = t; }
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        if (!userMoved.current) fitted.current = '';
        dirty.current = true;
      }
      const st = client.state;
      const key = st ? `${st.width}x${st.height}:${client.focus}` : '';
      if (st && fitted.current !== key) { fitted.current = key; fit(); }
      if (seen === client.version && !dirty.current) return;
      seen = client.version;
      dirty.current = false;
      draw(c, dpr);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [client, fit]);

  const draw = (c: HTMLCanvasElement, dpr: number) => {
    const g = c.getContext('2d')!;
    const p = propsRef.current;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = BG;
    g.fillRect(0, 0, c.width, c.height);
    const st = client.state;
    const doc = client.focusDoc;
    if (!st || !doc) return;
    const v = view.current;
    // Canvas shadow.
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.translate(v.x, v.y);
    g.rotate(v.rot);
    g.shadowColor = 'rgba(0,0,0,0.45)';
    g.shadowBlur = 24;
    g.shadowOffsetY = 6;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, st.width * v.zoom, st.height * v.zoom);
    g.shadowColor = 'transparent';
    g.scale(v.zoom / doc.scale, v.zoom / doc.scale);
    g.imageSmoothingEnabled = v.zoom < 3;
    g.imageSmoothingQuality = 'high';
    const img = st.image ? client.images.get(st.image.asset) : undefined;
    compose(g, doc, {
      paper: paperCanvas(st.paper, st.width, st.height, doc.scale),
      image: img && st.image ? { el: img, meta: st.image } : null,
      overlays: client.overlaysFor(doc.id),
    });
    // Symmetry guide.
    const sym = p.tools.sym;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (sym && client.canDraw) {
      g.save();
      g.strokeStyle = 'rgba(80,160,255,0.55)';
      g.setLineDash([6, 6]);
      g.lineWidth = 1;
      const line = (x0: number, y0: number, x1: number, y1: number) => {
        const a = toScreen(x0, y0), b = toScreen(x1, y1);
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      };
      if (sym.kind === 'vertical' || sym.kind === 'quadrant') line(sym.cx, 0, sym.cx, st.height);
      if (sym.kind === 'horizontal' || sym.kind === 'quadrant') line(0, sym.cy, st.width, sym.cy);
      if (sym.kind === 'radial') {
        const r = Math.hypot(st.width, st.height);
        for (let i = 0; i < sym.count; i++) {
          const a = (i / sym.count) * Math.PI * 2 - Math.PI / 2;
          line(sym.cx, sym.cy, sym.cx + Math.cos(a) * r, sym.cy + Math.sin(a) * r);
        }
      }
      g.restore();
    }
    // Other people's pens.
    for (const cur of client.cursors.values()) {
      if (cur.canvas !== doc.id) continue;
      const [sx, sy] = toScreen(cur.x, cur.y);
      const who = p.names[cur.by];
      g.fillStyle = cur.color;
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(sx, sy, 5, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (who) {
        g.font = '600 12px Inter, system-ui, sans-serif';
        const tw = g.measureText(who.name).width;
        g.fillStyle = who.color;
        roundRect(g, sx + 9, sy + 8, tw + 12, 20, 10);
        g.fill();
        g.fillStyle = '#fff';
        g.fillText(who.name, sx + 15, sy + 22);
      }
    }
    // My brush outline.
    const hv = hover.current;
    const tool = p.tools.tool;
    if (hv.visible && (tool === 'brush' || tool === 'eraser') && !stroke.current) {
      const r = (currentSize(p.tools) * v.zoom) / 2;
      g.strokeStyle = 'rgba(0,0,0,0.55)';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(hv.x, hv.y, Math.max(1.5, r), 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.beginPath();
      g.arc(hv.x, hv.y, Math.max(1.5, r) + 1, 0, Math.PI * 2);
      g.stroke();
    }
  };

  // --- picking and filling -------------------------------------------------

  const sampleAt = (x: number, y: number): string | null => {
    const st = client.state;
    const doc = client.focusDoc;
    if (!st || !doc || x < 0 || y < 0 || x >= st.width || y >= st.height) return null;
    const c = makeCanvas(1, 1);
    const g = ctx2d(c, true);
    g.setTransform(1, 0, 0, 1, -Math.floor(x * doc.scale), -Math.floor(y * doc.scale));
    const img = st.image ? client.images.get(st.image.asset) : undefined;
    compose(g, doc, {
      paper: paperCanvas(st.paper, st.width, st.height, doc.scale),
      image: img && st.image ? { el: img, meta: st.image } : null,
      overlays: [],
    });
    const d = g.getImageData(0, 0, 1, 1).data;
    return rgbToHex(d[0]!, d[1]!, d[2]!);
  };

  const fillAt = (x: number, y: number) => {
    const p = propsRef.current;
    const st = client.state;
    const doc = client.focusDoc;
    if (!st || !doc || doc.scale !== 1 || !p.layer || !client.canDraw) return;
    const W = st.width, H = st.height;
    const src = makeCanvas(W, H);
    const g = ctx2d(src, true);
    const img = st.image ? client.images.get(st.image.asset) : undefined;
    const linesMode = p.tools.fill.mode === 'lines' && img && st.image?.placement === 'lines';
    if (linesMode) {
      g.drawImage(img, 0, 0, W, H);
    } else if (p.tools.fill.sample === 'layer') {
      const l = doc.layer(p.layer);
      if (l) g.drawImage(l.canvas, 0, 0);
    } else {
      compose(g, doc, { paper: null, image: img && st.image ? { el: img, meta: st.image } : null, overlays: [] });
    }
    const data = g.getImageData(0, 0, W, H);
    const region = computeFill(data, x, y, { ...p.tools.fill, mode: linesMode ? 'lines' : 'color' });
    if (!region) return;
    void client.sendOp(newId(), doc.id, p.layer, {
      kind: 'fill', color: p.tools.color, opacity: Math.max(0.05, currentOpacity({ ...p.tools, tool: 'brush' })), ...region,
    });
  };

  // --- strokes -------------------------------------------------------------

  const pressureOf = (e: PointerEvent): number => {
    if (e.pointerType !== 'pen') return 1;
    const raw = e.pressure;
    if (!(raw > 0)) return 0.02;
    return Math.max(0.02, Math.min(1, Math.pow(raw, propsRef.current.tools.pressureGamma)));
  };

  const startStroke = (e: PointerEvent, erase: boolean) => {
    const p = propsRef.current;
    if (!client.canDraw || !p.layer) return;
    const t = p.tools;
    const brushId = erase ? t.eraser : activeBrushId({ ...t, tool: 'brush' });
    const tTool = { ...t, tool: erase ? 'eraser' as const : 'brush' as const };
    const brush = brushById(brushId);
    const st = client.state!;
    const sym = t.sym ? { ...t.sym, cx: t.sym.cx || st.width / 2, cy: t.sym.cy || st.height / 2 } : undefined;
    const renderer = client.beginStroke(p.layer, {
      brush: brushId,
      color: t.color,
      size: currentSize(tTool),
      opacity: currentOpacity(tTool),
      erase,
      seed: (Math.random() * 2 ** 31) >>> 0 || 1,
      sym,
    });
    if (!renderer) return;
    const [x, y] = toDoc(...local(e));
    const pr = pressureOf(e);
    stroke.current = {
      pointerId: e.pointerId, renderer, points: [], sx: x, sy: y, sp: pr, lastT: e.timeStamp,
      stream: Math.min(0.92, brush.streamline * 0.7 + t.stabilizer),
      raw: [[x, y, pr]], stillSince: e.timeStamp, stillX: x, stillY: y, shape: null, liveAt: 0, erase, sym,
    };
    addPoint(stroke.current, x, y, pr, e.tiltX ?? 0, e.tiltY ?? 0);
  };

  const addPoint = (s: Stroke, x: number, y: number, p: number, tx: number, ty: number) => {
    const r4 = (v: number) => Math.round(v * 100) / 100;
    const pts = [r4(x), r4(y), Math.round(p * 1000) / 1000, Math.round(tx), Math.round(ty)];
    s.points.push(...pts);
    s.renderer.push(pts);
  };

  const moveStroke = (e: PointerEvent) => {
    const s = stroke.current;
    if (!s) return;
    const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = samples.length ? samples : [e];
    for (const ev of list) {
      const [x, y] = toDoc(...local(ev));
      const pr = pressureOf(ev);
      s.raw.push([x, y, pr]);
      if (s.shape) continue;
      // Time-based exponential smoothing: the same feel at 60 or 200 Hz.
      const dt = Math.max(1, ev.timeStamp - s.lastT);
      s.lastT = ev.timeStamp;
      const k = 1 - Math.pow(s.stream, dt / 8);
      s.sx += (x - s.sx) * k;
      s.sy += (y - s.sy) * k;
      s.sp += (pr - s.sp) * Math.min(1, k * 1.6);
      const n = s.points.length;
      const lx = s.points[n - 5]!, ly = s.points[n - 4]!;
      if (Math.hypot(s.sx - lx, s.sy - ly) >= 0.35) addPoint(s, s.sx, s.sy, s.sp, ev.tiltX ?? 0, ev.tiltY ?? 0);
      // QuickShape: holding still.
      if (Math.hypot(x - s.stillX, y - s.stillY) > 4 / view.current.zoom) {
        s.stillX = x; s.stillY = y; s.stillSince = ev.timeStamp;
      }
    }
    if (s.shape) reshape(s);
    const now = performance.now();
    if (now - s.liveAt > 40 && !s.shape) {
      s.liveAt = now;
      client.sendLive(s.points);
    }
    client.changed();
  };

  /** Pen held still: snap the stroke to a line or an ellipse. */
  const checkQuickShape = () => {
    const s = stroke.current;
    const p = propsRef.current;
    if (!s || s.shape || !p.tools.quickShape || s.raw.length < 6) return;
    const last = s.raw[s.raw.length - 1]!;
    if (performance.now() - s.stillSince < 550) return;
    let len = 0;
    for (let i = 1; i < s.raw.length; i++) len += Math.hypot(s.raw[i]![0] - s.raw[i - 1]![0], s.raw[i]![1] - s.raw[i - 1]![1]);
    if (len * view.current.zoom < 40) return;
    const first = s.raw[0]!;
    const closed = Math.hypot(last[0] - first[0], last[1] - first[1]) < len * 0.18 && len * view.current.zoom > 120;
    s.shape = closed ? 'ellipse' : 'line';
    reshape(s);
    client.changed();
  };

  const reshape = (s: Stroke) => {
    const first = s.raw[0]!, last = s.raw[s.raw.length - 1]!;
    const avgP = s.raw.reduce((a, r) => a + r[2], 0) / s.raw.length;
    const pts: number[] = [];
    if (s.shape === 'line') {
      const n = Math.max(2, Math.ceil(Math.hypot(last[0] - first[0], last[1] - first[1]) / 4));
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        pts.push(first[0] + (last[0] - first[0]) * u, first[1] + (last[1] - first[1]) * u, avgP, 0, 0);
      }
    } else {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of s.raw) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
      const n = Math.max(24, Math.ceil((Math.PI * (rx + ry)) / 4));
      for (let i = 0; i <= n + 1; i++) {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, avgP, 0, 0);
      }
    }
    // Start the renderer again with the shape's points.
    const renderer = client.restartStroke();
    if (!renderer) return;
    s.renderer = renderer;
    s.points = pts.map((v, i) => (i % 5 < 2 ? Math.round(v * 100) / 100 : v));
    renderer.push(s.points);
  };

  const endStroke = (cancel: boolean) => {
    const s = stroke.current;
    stroke.current = null;
    if (!s) return;
    if (cancel) {
      client.cancelStroke();
      return;
    }
    if (!s.shape) {
      // Catch up from the smoothed point to where the pen lifted.
      const last = s.raw[s.raw.length - 1]!;
      const n = s.points.length;
      const lx = s.points[n - 5]!, ly = s.points[n - 4]!;
      const gap = Math.hypot(last[0] - lx, last[1] - ly);
      const steps = Math.min(8, Math.ceil(gap / 2));
      for (let i = 1; i <= steps; i++) {
        const u = i / steps;
        addPoint(s, lx + (last[0] - lx) * u, ly + (last[1] - ly) * u, s.sp * (1 - u * 0.3), 0, 0);
      }
    }
    client.sendLive(s.points);
    void client.endStroke(s.points, s.sym);
  };

  // --- pointer events ------------------------------------------------------

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  useEffect(() => {
    const c = canvasRef.current!;
    let qsTimer = 0;

    const startGesture = () => {
      const ids = [...pointers.current.entries()].filter(([, v]) => v.type === 'touch').map(([id]) => id).slice(0, 2);
      if (ids.length < 2) return;
      const a = pointers.current.get(ids[0]!)!, b = pointers.current.get(ids[1]!)!;
      gesture.current = {
        ids,
        startDist: Math.hypot(b.x - a.x, b.y - a.y),
        startAngle: Math.atan2(b.y - a.y, b.x - a.x),
        startMid: [(a.x + b.x) / 2, (a.y + b.y) / 2],
        startView: { ...view.current },
        startedAt: performance.now(),
        moved: 0,
        maxTouches: pointers.current.size,
      };
    };

    const onDown = (e: PointerEvent) => {
      const p = propsRef.current;
      const [lx, ly] = local(e);
      pointers.current.set(e.pointerId, { x: lx, y: ly, type: e.pointerType });
      if (e.pointerType === 'pen' && !penSeen.current) {
        penSeen.current = true;
        p.onPenSeen();
      }
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetic or already gone */ }
      e.preventDefault();

      if (e.pointerType === 'touch') {
        const touches = [...pointers.current.values()].filter((v) => v.type === 'touch').length;
        if (gesture.current) {
          gesture.current.maxTouches = Math.max(gesture.current.maxTouches, touches);
          return;
        }
        if (touches >= 2) {
          if (stroke.current) endStroke(true);
          pan.current = null;
          startGesture();
          return;
        }
        if (!p.tools.fingerPaint || penSeen.current) {
          pan.current = { id: e.pointerId, x: lx, y: ly, view: { ...view.current } };
          return;
        }
      }

      const middle = e.button === 1;
      if (middle || p.panKey || p.tools.tool === 'hand') {
        pan.current = { id: e.pointerId, x: lx, y: ly, view: { ...view.current } };
        return;
      }
      if (stroke.current) return;
      const [x, y] = toDoc(lx, ly);
      const penEraser = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0);
      const barrel = e.pointerType === 'pen' && (e.buttons & 2) !== 0;
      if (barrel || e.altKey || p.tools.tool === 'picker') {
        picking.current = e.pointerId;
        const col = sampleAt(x, y);
        if (col) p.onPick(col);
        return;
      }
      if (e.button === 2) return;
      if (p.tools.tool === 'fill' && !penEraser) {
        fillAt(x, y);
        return;
      }
      startStroke(e, penEraser || p.tools.tool === 'eraser');
      if (stroke.current) {
        window.clearInterval(qsTimer);
        qsTimer = window.setInterval(checkQuickShape, 60);
      }
    };

    const onMove = (e: PointerEvent) => {
      const [lx, ly] = local(e);
      const rec = pointers.current.get(e.pointerId);
      if (rec) { rec.x = lx; rec.y = ly; }
      if (e.pointerType !== 'touch') {
        hover.current = { x: lx, y: ly, visible: true };
        dirty.current = true;
      }
      const [dx, dy] = toDoc(lx, ly);
      const now = performance.now();
      if (now - cursorSent.current > 60 && e.pointerType !== 'touch') {
        cursorSent.current = now;
        client.sendCursor(Math.round(dx), Math.round(dy), propsRef.current.tools.color);
      }
      const g = gesture.current;
      if (g) {
        const a = pointers.current.get(g.ids[0]!), b = pointers.current.get(g.ids[1]!);
        if (!a || !b) return;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const mid: [number, number] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        g.moved = Math.max(g.moved, Math.hypot(mid[0] - g.startMid[0], mid[1] - g.startMid[1]), Math.abs(dist - g.startDist));
        // Keep the canvas point under the starting midpoint under the fingers.
        view.current = { ...g.startView };
        const [cx, cy] = toDoc(...g.startMid);
        let rot = g.startView.rot + (angle - g.startAngle);
        // Snap near-straight rotations.
        const snap = Math.round(rot / (Math.PI / 2)) * (Math.PI / 2);
        if (Math.abs(rot - snap) < 0.06) rot = snap;
        const zoom = Math.min(64, Math.max(0.05, g.startView.zoom * (dist / Math.max(1, g.startDist))));
        view.current = { ...view.current, zoom, rot };
        const [nx, ny] = toScreen(cx, cy);
        view.current.x += mid[0] - nx;
        view.current.y += mid[1] - ny;
        userMoved.current = true;
        dirty.current = true;
        propsRef.current.onZoom?.(zoom);
        return;
      }
      const pn = pan.current;
      if (pn && pn.id === e.pointerId) {
        view.current = { ...pn.view, x: pn.view.x + lx - pn.x, y: pn.view.y + ly - pn.y };
        userMoved.current = true;
        dirty.current = true;
        return;
      }
      if (picking.current === e.pointerId) {
        const col = sampleAt(dx, dy);
        if (col) propsRef.current.onPick(col);
        return;
      }
      if (stroke.current && stroke.current.pointerId === e.pointerId) moveStroke(e);
    };

    const onUp = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId);
      const g = gesture.current;
      if (g) {
        if (g.ids.includes(e.pointerId) || pointers.current.size === 0) {
          const tap = performance.now() - g.startedAt < 300 && g.moved < 14;
          if (pointers.current.size === 0) {
            gesture.current = null;
            if (tap) (g.maxTouches >= 3 ? propsRef.current.onRedo : propsRef.current.onUndo)();
          } else if (!tap) {
            gesture.current = null;
          }
        }
        return;
      }
      if (pan.current?.id === e.pointerId) { pan.current = null; return; }
      if (picking.current === e.pointerId) { picking.current = null; return; }
      if (stroke.current?.pointerId === e.pointerId) {
        window.clearInterval(qsTimer);
        if (e.type === 'pointercancel') endStroke(true);
        else {
          moveStroke(e);
          endStroke(false);
        }
      }
    };

    const onLeave = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') {
        hover.current.visible = false;
        dirty.current = true;
        client.sendCursor(0, 0, propsRef.current.tools.color, true);
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [lx, ly] = local(e);
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025) * 4), lx, ly);
      } else {
        const k = e.deltaMode === 1 ? 16 : 1;
        view.current = { ...view.current, x: view.current.x - (e.shiftKey ? e.deltaY : e.deltaX) * k, y: view.current.y - (e.shiftKey ? 0 : e.deltaY) * k };
        userMoved.current = true;
        dirty.current = true;
      }
    };

    const noMenu = (e: Event) => e.preventDefault();
    // Safari's own pinch gesture would zoom the page.
    const noGesture = (e: Event) => e.preventDefault();

    c.addEventListener('pointerdown', onDown);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointerup', onUp);
    c.addEventListener('pointercancel', onUp);
    c.addEventListener('pointerleave', onLeave);
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('contextmenu', noMenu);
    c.addEventListener('gesturestart', noGesture);
    return () => {
      window.clearInterval(qsTimer);
      c.removeEventListener('pointerdown', onDown);
      c.removeEventListener('pointermove', onMove);
      c.removeEventListener('pointerup', onUp);
      c.removeEventListener('pointercancel', onUp);
      c.removeEventListener('pointerleave', onLeave);
      c.removeEventListener('wheel', onWheel);
      c.removeEventListener('contextmenu', noMenu);
      c.removeEventListener('gesturestart', noGesture);
    };
  }, [client]);

  // Redraw the outline when the size changes from the slider.
  useEffect(() => { dirty.current = true; }, [props.tools]);

  const cursor = props.panKey || props.tools.tool === 'hand' ? 'grab'
    : props.tools.tool === 'picker' || props.tools.tool === 'fill' ? 'crosshair'
      : client.canDraw ? 'none' : 'default';

  return (
    <canvas
      ref={canvasRef}
      className="studio-surface"
      style={{ cursor }}
      data-canvas={client.focus === SHARED_CANVAS ? 'shared' : client.focus}
      aria-label="Drawing canvas"
    />
  );
});

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export default Surface;
