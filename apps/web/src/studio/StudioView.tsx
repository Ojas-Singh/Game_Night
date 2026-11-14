/**
 * The studio screen, Procreate-style: the canvas fills the window; tools
 * sit top right, size and opacity on a slim bar at the left, people and
 * (side by side) everyone's canvases along the bottom.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RoomApi } from '../useRoom.js';
import type { MediaChat } from '../useMediaChat.js';
import ChatPanel from '../chat/ChatPanel.js';
import TalkControls, { PeerAudioSinks } from '../table/TalkControls.js';
import { AVATAR_COLORS } from '../avatar.js';
import { StudioClient, newId } from './client.js';
import Surface, { type SurfaceHandle } from './Surface.js';
import { BrushLibrary, ColorPanel, FillPanel, LayersPanel, PenPanel, SymmetryPanel } from './panels.js';
import SetupPanel, { MODE_INFO } from './SetupPanel.js';
import { BRUSHES, brushById } from './engine/brushes.js';
import { compose, exportPng, paperCanvas } from './engine/render.js';
import { ctx2d } from './engine/tips.js';
import { Icon, type IconName } from './icons.js';
import {
  activeBrushId, currentOpacity, currentSize, useTools, withColor, withOpacity, withSize, type Tool,
} from './tools.js';
import { STUDIO_LIMITS } from '@game-night/shared';


type Panel = 'brush' | 'eraser' | 'color' | 'layers' | 'fill' | 'sym' | 'pen' | 'menu' | 'setup' | null;

function useStudioClient(room: RoomApi): StudioClient | null {
  const [client, setClient] = useState<StudioClient | null>(null);
  useEffect(() => {
    if (!room.socket || !room.roomId || !room.myPlayerId) return;
    const c = new StudioClient(room.socket, room.roomId, room.myPlayerId);
    // Test hook: ?studio-debug exposes the client to scripted browser tests.
    if (window.location.search.includes('studio-debug')) {
      Object.assign(window, { __studio: c, __studioBrushes: BRUSHES.map((b) => [b.id, b.defaultSize, b.name]) });
    }
    setClient(c);
    return () => c.dispose();
  }, [room.socket, room.roomId, room.myPlayerId]);
  return client;
}

const sizeToSlider = (s: number) => Math.log(s / 0.5) / Math.log(STUDIO_LIMITS.maxBrushSize / 0.5);
const sliderToSize = (v: number) => 0.5 * Math.pow(STUDIO_LIMITS.maxBrushSize / 0.5, v);

export default function StudioView({ room, media }: { room: RoomApi; media: MediaChat }) {
  const client = useStudioClient(room);
  if (!client) return <div className="studio studio-loading">Opening the studio…</div>;
  return <Studio room={room} media={media} client={client} />;
}

function Studio({ room, media, client }: { room: RoomApi; media: MediaChat; client: StudioClient }) {
  const version = useSyncExternalStore(client.subscribe, client.getVersion);
  const [tools, setTools] = useTools();
  const [panel, setPanel] = useState<Panel>(null);
  const [activeLayer, setActiveLayer] = useState<Record<string, string>>({});
  const [panKey, setPanKey] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [hideUi, setHideUi] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [toast, setToast] = useState<string | null>(null);
  const surface = useRef<SurfaceHandle>(null);
  const lobby = room.lobby!;
  const st = client.state;
  const isHost = lobby.hostId === room.myPlayerId;
  const doc = client.focusDoc;
  const canvasMeta = st?.canvases.find((c) => c.id === client.focus);
  const layers = canvasMeta?.layers ?? [];
  const layerId = (() => {
    const chosen = activeLayer[client.focus];
    if (chosen && layers.some((l) => l.id === chosen)) return chosen;
    return layers[layers.length - 1]?.id ?? null;
  })();

  // People in the room, with a colour each for cursors.
  const names = useMemo(() => {
    const out: Record<string, { name: string; color: string }> = {};
    for (const p of lobby.players) out[p.id] = { name: p.name, color: AVATAR_COLORS[p.avatar.color % AVATAR_COLORS.length]! };
    return out;
  }, [lobby.players]);

  // Errors from the server show as a toast.
  useEffect(() => {
    if (!client.error) return;
    setToast(client.error);
    client.clearError();
  }, [client, version]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const pickTool = useCallback((tool: Tool) => {
    setTools((t) => {
      if (t.tool === tool) {
        const p: Panel = tool === 'brush' ? 'brush' : tool === 'eraser' ? 'eraser' : tool === 'fill' ? 'fill' : null;
        setPanel((cur) => (cur === p ? null : p));
        return {};
      }
      setPanel(null);
      return { tool };
    });
  }, [setTools]);

  const undo = useCallback(() => void client.undo(), [client]);
  const redo = useCallback(() => void client.redo(), [client]);

  // Keyboard shortcuts (tablet express keys usually send these).
  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
      if (mod && k === 'y') { e.preventDefault(); redo(); return; }
      if (mod) return;
      if (e.code === 'Space') { e.preventDefault(); setPanKey(true); return; }
      switch (k) {
        case 'b': pickTool('brush'); break;
        case 'e': pickTool('eraser'); break;
        case 'g': pickTool('fill'); break;
        case 'i': pickTool('picker'); break;
        case 'h': pickTool('hand'); break;
        case 'l': setPanel((p) => (p === 'layers' ? null : 'layers')); break;
        case 'c': setPanel((p) => (p === 'color' ? null : 'color')); break;
        case '[': setTools((t) => withSize(t, Math.max(0.5, currentSize(t) / 1.15))); break;
        case ']': setTools((t) => withSize(t, Math.min(STUDIO_LIMITS.maxBrushSize, currentSize(t) * 1.15))); break;
        case '0': surface.current?.fit(); break;
        case '=': case '+': surface.current?.zoomBy(1.25); break;
        case '-': surface.current?.zoomBy(0.8); break;
        case 'r': surface.current?.resetRotation(); break;
        case 'tab': e.preventDefault(); setHideUi((h) => !h); break;
        case 'escape': setPanel(null); break;
        default:
          if (/^[1-9]$/.test(k)) setTools((t) => withOpacity(t, Number(k) / 10));
      }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setPanKey(false); };
    const blur = () => setPanKey(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [pickTool, setTools, undo, redo]);

  const onColor = useCallback((c: string, commit: boolean) => {
    setTools((t) => (commit ? withColor(t, c) : { color: c }));
  }, [setTools]);

  const exportImage = async (transparent: boolean) => {
    if (!doc || !st) return;
    const img = st.image ? client.images.get(st.image.asset) : undefined;
    const blob = await exportPng(doc, {
      paper: paperCanvas(st.paper, st.width, st.height, doc.scale),
      image: img && st.image ? { el: img, meta: st.image } : null,
      overlays: [],
    }, transparent);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `game-night-${lobby.roomId.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    setPanel(null);
  };

  const copyInvite = async () => {
    const link = `${window.location.origin}/game/${lobby.roomId}`;
    try { await navigator.clipboard.writeText(link); setToast('Invite link copied'); } catch { setToast(link); }
    setPanel(null);
  };

  if (!st || !client.ready) {
    return (
      <div className="studio studio-loading">
        <span className="st-spinner" aria-hidden /> Opening the studio…
      </div>
    );
  }

  const tool = tools.tool;
  const size = currentSize(tools);
  const opacity = currentOpacity(tools);
  const brush = brushById(activeBrushId(tools));
  const sideBySide = st.mode === 'side-by-side';
  const focusOwner = canvasMeta?.ownerId ? lobby.players.find((p) => p.id === canvasMeta.ownerId) : null;
  const lookingAtOther = sideBySide && client.focus !== client.myCanvas;
  const toolBtn = (t: Tool, icon: IconName, label: string, key: string) => (
    <button
      className={`st-tool ${tool === t ? 'on' : ''}`}
      onClick={() => pickTool(t)}
      title={`${label} (${key})`}
      aria-label={label}
      aria-pressed={tool === t}
    >
      <Icon name={icon} />
    </button>
  );

  return (
    <div className={`studio ${hideUi ? 'ui-hidden' : ''}`} data-mode={st.mode}>
      <PeerAudioSinks media={media} />
      <Surface
        ref={surface}
        client={client}
        tools={tools}
        layer={layerId}
        names={names}
        panKey={panKey}
        onPick={(c) => onColor(c, true)}
        onUndo={undo}
        onRedo={redo}
        onPenSeen={() => tools.fingerPaint && setTools({ fingerPaint: false })}
        onZoom={setZoom}
      />

      {/* --- top bar --- */}
      <header className="st-top">
        <div className="st-top-left">
          <button className="st-tool" onClick={() => setPanel(panel === 'menu' ? null : 'menu')} aria-label="Menu" title="Menu">
            <Icon name="menu" />
          </button>
          <div className="st-title">
            <strong>{MODE_INFO[st.mode].name}</strong>
            <small>
              Room {lobby.roomId}
              {lookingAtOther && focusOwner ? ` · ${focusOwner.name}’s canvas` : ''}
              {!st.open ? ' · closed' : ''}
            </small>
          </div>
          {isHost && (
            <button className="st-tool" onClick={() => setPanel(panel === 'setup' ? null : 'setup')} aria-label="Studio settings" title="Studio settings">
              <Icon name="settings" />
            </button>
          )}
        </div>
        <div className="st-top-right">
          {toolBtn('brush', 'brush', 'Brush', 'B')}
          {toolBtn('eraser', 'eraser', 'Eraser', 'E')}
          {toolBtn('fill', 'fill', 'Fill', 'G')}
          {toolBtn('picker', 'picker', 'Colour picker', 'I')}
          <button className={`st-tool ${tools.sym ? 'on' : ''}`} onClick={() => setPanel(panel === 'sym' ? null : 'sym')} aria-label="Symmetry" title="Symmetry">
            <Icon name="sym" />
          </button>
          <button className={`st-tool ${panel === 'layers' ? 'on' : ''}`} onClick={() => setPanel(panel === 'layers' ? null : 'layers')} aria-label="Layers" title="Layers (L)">
            <Icon name="layers" />
          </button>
          <button className="st-color-btn" onClick={() => setPanel(panel === 'color' ? null : 'color')} aria-label="Colour" title="Colour (C)">
            <span style={{ background: tools.color }} />
          </button>
        </div>
      </header>

      {/* --- left bar: size, opacity, undo --- */}
      <aside className="st-side" aria-label="Brush size and opacity">
        <VSlider
          label="Size"
          value={sizeToSlider(size)}
          display={size < 10 ? size.toFixed(1) : String(Math.round(size))}
          onChange={(v) => setTools((t) => withSize(t, sliderToSize(v)))}
        />
        <button className="st-side-btn" onClick={() => pickTool('picker')} aria-label="Colour picker" title="Colour picker (I, or Alt / pen button)">
          <span className="st-side-swatch" style={{ background: tools.color }} />
        </button>
        <VSlider
          label="Opacity"
          value={opacity}
          display={`${Math.round(opacity * 100)}%`}
          onChange={(v) => setTools((t) => withOpacity(t, Math.max(0.02, v)))}
        />
        <button className="st-side-btn" onClick={undo} disabled={!client.undoStack.length} aria-label="Undo" title="Undo (Ctrl+Z, two-finger tap)">
          <Icon name="undo" size={20} />
        </button>
        <button className="st-side-btn" onClick={redo} disabled={!client.redoStack.length} aria-label="Redo" title="Redo (Ctrl+Shift+Z)">
          <Icon name="redo" size={20} />
        </button>
      </aside>

      {/* --- current brush chip and view controls --- */}
      <div className="st-brush-chip" onClick={() => pickTool(tool === 'eraser' ? 'eraser' : 'brush')}>
        {tool === 'eraser' ? 'Eraser · ' : ''}{brush.name}
      </div>
      <div className="st-view-ctl">
        <button onClick={() => surface.current?.zoomBy(0.8)} aria-label="Zoom out">−</button>
        <button onClick={() => surface.current?.fit()} title="Fit (0)">{Math.round(zoom * 100)}%</button>
        <button onClick={() => surface.current?.zoomBy(1.25)} aria-label="Zoom in">+</button>
        <button onClick={() => pickTool('hand')} className={tool === 'hand' ? 'on' : ''} aria-label="Move the canvas" title="Move (H, or hold Space)">
          <Icon name="hand" size={18} />
        </button>
      </div>

      {/* --- people and canvases --- */}
      <footer className="st-bottom">
        <div className="st-people">
          {lobby.players.map((p) => (
            <span key={p.id} className={`st-person ${p.connected ? '' : 'away'} ${p.id === room.myPlayerId ? 'me' : ''}`}
              style={{ ['--pc' as string]: names[p.id]?.color }} title={p.name}>
              {p.name.slice(0, 1).toUpperCase()}
              {p.isHost && <i aria-hidden>★</i>}
            </span>
          ))}
          {room.myPlayerId && <TalkControls media={media} playerId={room.myPlayerId} isYou variant="bar" />}
          <button className={`st-side-btn chat ${chatOpen ? 'on' : ''}`} onClick={() => { setChatOpen(!chatOpen); room.markChatRead(); }} aria-label="Chat">
            <Icon name="chat" size={18} />
            {room.unreadChat > 0 && !chatOpen && <b className="st-badge">{room.unreadChat}</b>}
          </button>
        </div>
        {sideBySide && (
          <Gallery client={client} version={version} names={names} isHost={isHost} myId={room.myPlayerId ?? ''} />
        )}
      </footer>

      {chatOpen && <div className="st-chat"><ChatPanel room={room} expanded /></div>}

      {!client.canDraw && st.open && lookingAtOther && (
        <div className="st-banner">
          Looking at {focusOwner?.name ?? 'someone'}’s canvas
          <button onClick={() => client.setFocus(client.myCanvas)}>Back to mine</button>
        </div>
      )}
      {!st.open && (
        <div className="st-banner">The host closed the studio. Your drawing is kept.</div>
      )}

      {/* --- panels --- */}
      {panel && <div className="st-scrim" onPointerDown={() => setPanel(null)} />}
      {panel === 'brush' && (
        <div className="st-pop right"><BrushLibrary tools={tools} eraser={false} onPick={(id) => setTools({ brush: id, tool: 'brush' })} /></div>
      )}
      {panel === 'eraser' && (
        <div className="st-pop right"><BrushLibrary tools={tools} eraser onPick={(id) => setTools({ eraser: id, tool: 'eraser' })} /></div>
      )}
      {panel === 'color' && (
        <div className="st-pop right"><ColorPanel tools={tools} onColor={onColor} /></div>
      )}
      {panel === 'fill' && (
        <div className="st-pop right">
          <FillPanel tools={tools} hasLines={st.image?.placement === 'lines'} onChange={(f) => setTools((t) => ({ fill: { ...t.fill, ...f } }))} />
        </div>
      )}
      {panel === 'sym' && (
        <div className="st-pop right"><SymmetryPanel tools={tools} width={st.width} height={st.height} onChange={(sym) => setTools({ sym })} /></div>
      )}
      {panel === 'pen' && (
        <div className="st-pop left"><PenPanel tools={tools} onChange={(p) => setTools(p)} /></div>
      )}
      {panel === 'layers' && (
        <div className="st-pop right">
          <LayersPanel
            doc={doc}
            layers={layers}
            active={layerId}
            canEdit={client.canDraw}
            version={version}
            onSelect={(id) => setActiveLayer((a) => ({ ...a, [client.focus]: id }))}
            onEdit={(edit) => void client.editLayers({ ...edit, canvas: client.focus } as never)}
            onAdd={() => {
              const id = `l-${newId().slice(0, 8)}`;
              const index = layerId ? layers.findIndex((l) => l.id === layerId) + 1 : layers.length;
              void client.editLayers({
                kind: 'add', canvas: client.focus, index,
                layer: { id, name: `Layer ${layers.length + 1}`, visible: true, opacity: 1, blend: 'normal', base: null },
              }).then((ok) => ok && setActiveLayer((a) => ({ ...a, [client.focus]: id })));
            }}
            onClear={(id) => void client.sendOp(newId(), client.focus, id, { kind: 'clear' })}
          />
        </div>
      )}
      {panel === 'menu' && (
        <div className="st-pop left">
          <div className="st-panel st-menu" role="menu">
            <button role="menuitem" onClick={() => void copyInvite()}><Icon name="link" size={18} /> Copy invite link</button>
            <button role="menuitem" onClick={() => void exportImage(false)}><Icon name="download" size={18} /> Save picture (PNG)</button>
            <button role="menuitem" onClick={() => void exportImage(true)}><Icon name="download" size={18} /> Save without paper</button>
            <button role="menuitem" onClick={() => setPanel('pen')}><Icon name="brush" size={18} /> Pen &amp; touch settings</button>
            <button role="menuitem" onClick={() => { surface.current?.fit(); setPanel(null); }}><Icon name="fit" size={18} /> Fit canvas to screen</button>
            <button role="menuitem" onClick={() => { toggleFullscreen(); setPanel(null); }}><Icon name="fit" size={18} /> Full screen</button>
            {isHost && <button role="menuitem" onClick={() => setPanel('setup')}><Icon name="settings" size={18} /> Mode, picture &amp; paper</button>}
            {isHost && (
              <button role="menuitem" onClick={() => { if (window.confirm('Start a fresh canvas for everyone? This drawing goes away (save it first).')) { void client.wipe(); setPanel(null); } }}>
                <Icon name="trash" size={18} /> Start a fresh canvas
              </button>
            )}
            {isHost ? (
              <button role="menuitem" onClick={() => { void client.close(); setPanel(null); }}><Icon name="back" size={18} /> Back to the lobby</button>
            ) : (
              <button role="menuitem" onClick={() => { if (window.confirm('Leave this room?')) { room.leaveRoom(); window.location.assign('/'); } }}>
                <Icon name="back" size={18} /> Leave the room
              </button>
            )}
            <p className="st-hint">Space-drag or two fingers to move · Ctrl+scroll or pinch to zoom · Tab hides the tools</p>
          </div>
        </div>
      )}
      {panel === 'setup' && isHost && (
        <div className="st-pop left wide">
          <div className="st-panel">
            <div className="st-panel-head">Studio</div>
            <SetupPanel
              roomId={lobby.roomId}
              live
              compact
              value={{ mode: st.mode, paper: st.paper, width: st.width, height: st.height, image: st.image }}
              onChange={(patch) => client.setup(patch)}
            />
            {sideBySide && (
              <label className="st-check">
                <input type="checkbox" checked={st.hidden} onChange={(e) => void client.setup({ hidden: e.target.checked })} />
                Keep canvases secret until I reveal them
              </label>
            )}
          </div>
        </div>
      )}
      {toast && <div className="st-toast" role="status">{toast}</div>}
    </div>
  );
}

function toggleFullscreen(): void {
  const d = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  if (document.fullscreenElement || d.webkitFullscreenElement) {
    void (document.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
  } else {
    void (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.());
  }
}

/** A vertical slider like Procreate's sidebar. */
function VSlider({ label, value, display, onChange }: { label: string; value: number; display: string; onChange: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current!;
    el.setPointerCapture(e.pointerId);
    setActive(true);
    const r = el.getBoundingClientRect();
    const at = (y: number) => onChange(Math.min(1, Math.max(0, 1 - (y - r.top) / r.height)));
    at(e.clientY);
    const move = (ev: PointerEvent) => at(ev.clientY);
    const up = () => {
      setActive(false);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') onChange(Math.min(1, value + 0.03));
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') onChange(Math.max(0, value - 0.03));
  };
  return (
    <div
      ref={ref}
      className={`st-vslider ${active ? 'active' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      aria-valuetext={display}
      onPointerDown={onDown}
      onKeyDown={onKey}
    >
      <span className="st-vslider-fill" style={{ height: `${value * 100}%` }} />
      <span className="st-vslider-knob" style={{ bottom: `calc(${value * 100}% - 7px)` }} />
      {active && <span className="st-vslider-bubble">{label} {display}</span>}
    </div>
  );
}

/** Side by side: everyone's canvas as a thumbnail; tap to look closer. */
function Gallery({ client, version, names, isHost, myId }: {
  client: StudioClient; version: number; names: Record<string, { name: string; color: string }>; isHost: boolean; myId: string;
}) {
  const st = client.state!;
  return (
    <div className="st-gallery">
      {st.canvases.map((c) => {
        const secret = st.hidden && !isHost && c.ownerId !== myId;
        return (
          <button key={c.id} className={`st-thumb ${client.focus === c.id ? 'on' : ''}`} disabled={secret}
            onClick={() => client.setFocus(c.id)} title={secret ? 'Hidden until the host reveals' : names[c.ownerId ?? '']?.name}>
            <Thumb client={client} canvasId={c.id} version={version} secret={secret} />
            <span>{c.ownerId === myId ? 'You' : names[c.ownerId ?? '']?.name ?? '—'}</span>
          </button>
        );
      })}
      {isHost && st.hidden && (
        <button className="st-btn reveal" onClick={() => void client.setup({ hidden: false })}>Reveal all</button>
      )}
    </div>
  );
}

function Thumb({ client, canvasId, version, secret }: { client: StudioClient; canvasId: string; version: number; secret: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(version);
  useEffect(() => {
    const t = setTimeout(() => setTick(version), 250);
    return () => clearTimeout(t);
  }, [version]);
  useEffect(() => {
    const c = ref.current;
    const doc = client.docs.get(canvasId);
    const st = client.state;
    if (!c || !doc || !st) return;
    const g = ctx2d(c);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(c.width / doc.pxWidth, 0, 0, c.height / doc.pxHeight, 0, 0);
    const img = st.image ? client.images.get(st.image.asset) : undefined;
    compose(g, doc, {
      paper: paperCanvas(st.paper, st.width, st.height, doc.scale),
      image: img && st.image ? { el: img, meta: st.image } : null,
      overlays: client.overlaysFor(canvasId),
    });
  }, [client, canvasId, tick]);
  const w = 96;
  const h = client.state ? Math.round((w * client.state.height) / client.state.width) : 72;
  return <canvas ref={ref} width={w * 2} height={h * 2} style={{ width: w, height: h, filter: secret ? 'blur(8px)' : undefined }} />;
}
