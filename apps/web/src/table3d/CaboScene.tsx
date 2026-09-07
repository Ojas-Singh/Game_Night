/**
 * The Cabo table in react-three-fiber.
 *
 * This is the visual table layer: felt, piles, fanned card hands, flight
 * ghosts, turn rings and seat pills. ALL gameplay state and intent logic
 * still lives in TableView — the scene only receives the derived view, the
 * pure layout (layout.ts) and the same click handlers the DOM cards use, so
 * the two renderers can never disagree about what a click means.
 *
 * Perf budget: ~30 card meshes + piles, no shadow maps, dpr capped at 1.75.
 */

import { Suspense, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { easing } from 'maath';
import type { CaboPlayerView } from '@cabo/views.js';
import type { Rank, Suit } from '@shared/cards.js';
import { feltStyle } from '../cosmetics.js';
import type { RoomApi, CardFlight } from '../useRoom.js';
import Avatar from '../table/Avatar.js';
import FloatingEmote from '../table/FloatingEmote.js';
import {
  buildSceneLayout,
  CARD_H,
  CARD_W,
  flightAnchor,
  type CardInstance,
  type SeatLayout,
  type Vec3,
} from './layout.js';
import { cardFaceSpec, drawBackCanvas, drawFaceCanvas, drawFeltCanvas, drawFlightCanvas } from './textures.js';

export interface CaboSceneProps {
  view: CaboPlayerView;
  room: RoomApi;
  myId: string;
  opponentIds: string[];
  flights: CardFlight[];
  /** Current interaction mode label (drives lifts/cursors, not logic). */
  mode: string;
  selectedOwn: string | null;
  targetPlayer: string | null;
  myCardsLifted: boolean;
  onMyCardClick: (cardId: string) => void;
  onOpponentCardClick: (playerId: string, cardId: string) => void;
  onOpponentClick: (playerId: string) => void;
  opponentSelectable: (playerId: string) => boolean;
  onDraw: (() => void) | null;
  onCallCabo: (() => void) | null;
  onDiscardDrawn: (() => void) | null;
  onFlightDone: (id: string) => void;
  /** Equipped cosmetics per player (server-verified). */
  loadouts?: Record<string, { cardBack?: string; feltTheme?: string }>;
}

// ---------------------------------------------------------------------------
// Textures (module-level caches; canvases are generated once per rank:suit)
// ---------------------------------------------------------------------------

const faceTexCache = new Map<string, THREE.CanvasTexture>();
function faceTexture(rank: Rank, suit: Suit): THREE.CanvasTexture {
  const key = `${rank}:${suit}`;
  let tex = faceTexCache.get(key);
  if (!tex) {
    tex = new THREE.CanvasTexture(drawFaceCanvas(rank, suit));
    tex.anisotropy = 4;
    tex.colorSpace = THREE.SRGBColorSpace;
    faceTexCache.set(key, tex);
  }
  return tex;
}
const backTexCache = new Map<string, THREE.CanvasTexture>();
function backTexture(sku?: string): THREE.CanvasTexture {
  const key = sku ?? 'default';
  let tex = backTexCache.get(key);
  if (!tex) {
    tex = new THREE.CanvasTexture(drawBackCanvas(sku));
    tex.colorSpace = THREE.SRGBColorSpace;
    backTexCache.set(key, tex);
  }
  return tex;
}
const flightTexCache = new Map<number, THREE.CanvasTexture>();
function flightTexture(rank: number): THREE.CanvasTexture {
  let tex = flightTexCache.get(rank);
  if (!tex) {
    tex = new THREE.CanvasTexture(drawFlightCanvas(rank));
    tex.colorSpace = THREE.SRGBColorSpace;
    flightTexCache.set(rank, tex);
  }
  return tex;
}
const feltTexCache = new Map<string, THREE.CanvasTexture>();
function feltTexture(sku?: string): THREE.CanvasTexture {
  const key = sku ?? 'default';
  let tex = feltTexCache.get(key);
  if (tex) return tex;
  tex = new THREE.CanvasTexture(drawFeltCanvas(sku));
  tex.colorSpace = THREE.SRGBColorSpace;
  feltTexCache.set(key, tex);
  return tex;
}

// ---------------------------------------------------------------------------
// Card mesh
// ---------------------------------------------------------------------------

const CARD_THICK = 0.018;

function CardMesh({
  instance,
  revealedRank,
  revealedSuit,
  selectable,
  highlight,
  backSku,
  onClick,
}: {
  instance: CardInstance;
  revealedRank: Rank | null;
  revealedSuit: Suit | null;
  selectable: boolean;
  highlight: boolean;
  backSku?: string;
  onClick?: () => void;
}) {
  const group = useRef<THREE.Group>(null!);
  const [hover, setHover] = useState(false);

  // Faces: index 2 = +y (front), 3 = -y (back).
  const frontMap =
    instance.faceUp && revealedRank !== null && revealedSuit !== null
      ? faceTexture(revealedRank, revealedSuit)
      : null;

  const targetX = instance.faceUp && frontMap ? 0 : Math.PI;
  const lift = instance.lifted || highlight ? CARD_H * 0.3 : hover && selectable ? CARD_H * 0.12 : 0;

  useFrame((_, delta) => {
    const g = group.current;
    if (!g) return;
    // Flip around the card's width axis; front shows at 0, back at PI.
    easing.damp(g.rotation, 'x', targetX, 0.16, delta);
    easing.damp3(g.position, [instance.pos.x, instance.pos.y + lift, instance.pos.z], 0.14, delta);
    easing.damp(g.rotation, 'y', instance.rotationY, 0.18, delta);
  });

  if (instance.emptySlot) {
    return (
      <mesh position={[instance.pos.x, 0.005, instance.pos.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[CARD_W * 1.04, CARD_H * 1.04]} />
        <meshBasicMaterial color="#12251a" transparent opacity={0.55} />
      </mesh>
    );
  }

  return (
    <group ref={group} position={[instance.pos.x, instance.pos.y + lift, instance.pos.z]} rotation={[targetX, instance.rotationY, 0]}>
      <mesh
        onClick={
          onClick
            ? (e) => {
                e.stopPropagation();
                onClick();
              }
            : undefined
        }
        onPointerOver={
          selectable
            ? (e) => {
                e.stopPropagation();
                setHover(true);
                document.body.style.cursor = 'pointer';
              }
            : undefined
        }
        onPointerOut={() => {
          setHover(false);
          if (selectable) document.body.style.cursor = 'auto';
        }}
      >
        <boxGeometry args={[CARD_W, CARD_THICK, CARD_H]} />
        {/* +x, -x, +y (front), -y (back), +z, -z */}
        <meshStandardMaterial attach="material-0" color="#e9e2d2" />
        <meshStandardMaterial attach="material-1" color="#e9e2d2" />
        <meshStandardMaterial attach="material-2"
          map={frontMap ?? undefined}
          color={frontMap ? '#ffffff' : '#e9e2d2'}
          roughness={0.55}
        />
        <meshStandardMaterial attach="material-3" map={backTexture(backSku)} roughness={0.6} />
        <meshStandardMaterial attach="material-4" color="#e9e2d2" />
        <meshStandardMaterial attach="material-5" color="#e9e2d2" />
      </mesh>
      {highlight && (
        <mesh position={[0, -CARD_THICK, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[CARD_W * 1.5, CARD_H * 1.35]} />
          <meshBasicMaterial color="#ffd88a" transparent opacity={0.5} />
        </mesh>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Piles
// ---------------------------------------------------------------------------

function Pile({
  pos,
  count,
  topFace,
  onTopClick,
}: {
  pos: Vec3;
  count: number;
  topFace?: { rank: Rank; suit: Suit } | null;
  onTopClick?: (() => void) | null;
}) {
  const layers = Math.max(1, Math.min(6, count));
  const step = 0.016;
  const cards = [];
  for (let i = 0; i < layers; i++) {
    const isTop = i === layers - 1;
    cards.push(
      <group key={i} position={[pos.x + (topFace ? 0 : i * 0.006), 0.01 + i * step, pos.z + i * 0.004]}>
        <mesh onClick={isTop && onTopClick ? (e) => { e.stopPropagation(); onTopClick(); } : undefined}>
          <boxGeometry args={[CARD_W, CARD_THICK, CARD_H]} />
          {isTop && topFace ? (
            <>
              <meshStandardMaterial attach="material-0" color="#e9e2d2" />
              <meshStandardMaterial attach="material-1" color="#e9e2d2" />
              <meshStandardMaterial attach="material-2" map={faceTexture(topFace.rank, topFace.suit)} roughness={0.55} />
              <meshStandardMaterial attach="material-3" map={backTexture()} roughness={0.6} />
              <meshStandardMaterial attach="material-4" color="#e9e2d2" />
              <meshStandardMaterial attach="material-5" color="#e9e2d2" />
            </>
          ) : (
            <>
              <meshStandardMaterial attach="material-2" map={backTexture()} roughness={0.6} />
              <meshStandardMaterial attach="material-3" color="#e9e2d2" />
              <meshStandardMaterial attach="material-0" color="#e9e2d2" />
              <meshStandardMaterial attach="material-1" color="#e9e2d2" />
              <meshStandardMaterial attach="material-4" color="#e9e2d2" />
              <meshStandardMaterial attach="material-5" color="#e9e2d2" />
            </>
          )}
        </mesh>
      </group>,
    );
  }
  return <group>{cards}</group>;
}

// ---------------------------------------------------------------------------
// Flight ghosts
// ---------------------------------------------------------------------------

const FLIGHT_MS = 620;

function FlightGhost({ flight, layout, onDone }: { flight: CardFlight; layout: ReturnType<typeof buildSceneLayout>; onDone: (id: string) => void }) {
  const mesh = useRef<THREE.Group>(null!);
  const mat = useRef<THREE.MeshStandardMaterial>(null!);
  const done = useRef(false);
  const from = useMemo(
    () =>
      flightAnchor(layout, {
        playerId: flight.fromPlayerId === 'deck' ? undefined : flight.fromPlayerId,
        pile: flight.fromPlayerId === 'deck' ? 'deck' : undefined,
        cardId: flight.fromCardId,
      }),
    [layout, flight],
  );
  const to = useMemo(
    () =>
      flightAnchor(layout, {
        playerId: flight.toPlayerId,
        pile: flight.toDiscard ? 'discard' : flight.toPlayerId ? undefined : 'draw',
        cardId: flight.toCardId,
      }),
    [layout, flight],
  );
  const start = useRef(performance.now());

  useFrame(() => {
    const g = mesh.current;
    if (!g) return;
    const t = Math.min(1, (performance.now() - start.current) / FLIGHT_MS);
    const e = t * t * (3 - 2 * t); // smoothstep
    g.position.set(
      from.x + (to.x - from.x) * e,
      0.15 + Math.sin(Math.PI * e) * 0.85,
      from.z + (to.z - from.z) * e,
    );
    if (mat.current) mat.current.opacity = t > 0.82 ? 1 - (t - 0.82) / 0.18 : 1;
    if (t >= 1 && !done.current) {
      done.current = true;
      onDone(flight.id);
    }
  });

  const isPeek = flight.kind === 'peek';
  return (
    <group ref={mesh} position={[from.x, 0.15, from.z]}>
      {isPeek ? (
        <mesh>
          <icosahedronGeometry args={[0.14, 0]} />
          <meshStandardMaterial ref={mat} color="#ffd88a" emissive="#ffb340" emissiveIntensity={1.6} transparent />
        </mesh>
      ) : (
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[CARD_W * 0.92, CARD_H * 0.92]} />
          <meshStandardMaterial ref={mat} map={flightTexture(flight.rank)} transparent />
        </mesh>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Seat pill (avatar + name + controls) floating over the seat
// ---------------------------------------------------------------------------

function SeatPill({
  seat,
  name,
  isTurn,
  glowing,
  emote,
  avatar,
  isHostMe,
  humanSeat,
  caboCaller,
  onClick,
  onKick,
  onReport,
}: {
  seat: SeatLayout;
  name: string;
  isTurn: boolean;
  glowing: boolean;
  emote?: { emote: string; at: number };
  avatar: { color: number; eyes: number; mouth: number; hat: number };
  isHostMe: boolean;
  humanSeat: boolean;
  caboCaller: boolean;
  onClick: () => void;
  onKick?: () => void;
  onReport: () => void;
}) {
  return (
    <Html position={[seat.pos.x, 0.1, seat.pos.z - 0.55]} center distanceFactor={8} zIndexRange={[20, 0]}>
      <div className="seat3d-pill">
        {isHostMe && humanSeat && (
          <button className="autopilot-toggle" onClick={onKick} title="Hand this seat to the autopilot bot (host)">
            🤖
          </button>
        )}
        <button className={`seat-who seat-who-3d ${isTurn ? 'is-turn-pill' : ''} ${glowing ? 'glow' : ''}`} onClick={onClick}>
          <Avatar avatar={avatar} size={42} crown={isTurn} ring={isTurn} cabo={caboCaller} />
          <span className="seat-name">{name}</span>
        </button>
        {!isHostMe && (
          <button
            className="report-btn"
            title={`Report ${name} to the host`}
            onClick={onReport}
          >
            ⚑
          </button>
        )}
        {emote && <FloatingEmote emote={emote} />}
      </div>
    </Html>
  );
}

// ---------------------------------------------------------------------------
// Camera: gentle cabo push-in
// ---------------------------------------------------------------------------

function CameraRig({ pushUntil }: { pushUntil: number }) {
  const { camera } = useThree();
  useFrame((_, delta) => {
    const pushing = performance.now() < pushUntil;
    easing.damp3(camera.position, pushing ? [0, 4.9, 4.1] : [0, 6.4, 5.4], pushing ? 0.5 : 1.2, delta);
  });
  return null;
}

// ---------------------------------------------------------------------------
// Scene contents
// ---------------------------------------------------------------------------

function SceneContents(props: CaboSceneProps) {
  const { view, room, myId, opponentIds, flights, mode } = props;

  const layout = useMemo(
    () => buildSceneLayout({ view, opponentIds, myId }),
    // Rebuild on revision + hand shape; selection lifts are applied separately.
    [view, opponentIds, myId, view.revision],
  );

  const caboFlashUntil = room.caboAnnounce ? room.caboAnnounce.at + 2600 : 0;

  const liftIds = useMemo(() => {
    const set = new Set<string>();
    if (props.myCardsLifted) for (const c of layout.myCards) if (!c.emptySlot) set.add(c.cardId);
    if (props.selectedOwn) set.add(props.selectedOwn);
    return set;
  }, [props.myCardsLifted, props.selectedOwn, layout]);

  const discardTop = view.discardTop;
  const drawn = view.drawnCard;
  const loadouts = props.loadouts ?? {};
  const hostFelt = loadouts[room.lobby?.hostId ?? '']?.feltTheme;
  const myBack = loadouts[myId]?.cardBack;

  return (
    <>
      <CameraRig pushUntil={caboFlashUntil} />
      <ambientLight intensity={0.85} />
      <directionalLight position={[3, 8, 4]} intensity={1.1} color="#fff4e0" />
      <pointLight position={[-4, 5, -3]} intensity={0.35} color="#9fd6ff" />

      {/* felt table */}
      <group>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
          <circleGeometry args={[4.6, 64]} />
          <meshStandardMaterial map={feltTexture(hostFelt)} roughness={0.9} />
        </mesh>
        <mesh position={[0, -0.06, 0]}>
          <cylinderGeometry args={[4.6, 4.35, 0.18, 64]} />
          <meshStandardMaterial color={feltStyle(hostFelt).rail} roughness={0.7} />
        </mesh>
      </group>

      {/* deck + discard piles */}
      <Pile pos={layout.deckPos} count={layout.deckCount} />
      <Pile pos={layout.discardPos} count={discardTop ? 4 : 0} topFace={discardTop} />
      {props.onDraw && (
        <Html position={[layout.deckPos.x, 0.25, layout.deckPos.z + 0.75]} center distanceFactor={8}>
          <button className="pile-action-btn" onClick={props.onDraw}>
            Draw a card
          </button>
        </Html>
      )}
      {props.onCallCabo && (
        <Html position={[layout.discardPos.x, 0.3, layout.discardPos.z + 0.8]} center distanceFactor={8}>
          <button className="pile-action-btn cabo" onClick={props.onCallCabo}>
            Call Cabo!
          </button>
        </Html>
      )}

      {/* drawn card slot — raised, discardable while deciding */}
      {drawn && (
        <group position={[layout.drawnPos.x, layout.drawnPos.y, layout.drawnPos.z]}>
          <mesh
            position={[0, 0, 0]}
            rotation={[0, 0.35, 0]}
            onClick={props.onDiscardDrawn ? (e) => { e.stopPropagation(); props.onDiscardDrawn?.(); } : undefined}
            onPointerOver={props.onDiscardDrawn ? () => { document.body.style.cursor = 'pointer'; } : undefined}
            onPointerOut={props.onDiscardDrawn ? () => { document.body.style.cursor = 'auto'; } : undefined}
          >
            <boxGeometry args={[CARD_W, CARD_THICK, CARD_H]} />
            <meshStandardMaterial attach="material-0" color="#e9e2d2" />
            <meshStandardMaterial attach="material-1" color="#e9e2d2" />
            <meshStandardMaterial attach="material-2" map={faceTexture(drawn.rank, drawn.suit)} roughness={0.55} />
            <meshStandardMaterial attach="material-3" map={backTexture()} roughness={0.6} />
            <meshStandardMaterial attach="material-4" color="#e9e2d2" />
            <meshStandardMaterial attach="material-5" color="#e9e2d2" />
          </mesh>
        </group>
      )}

      {/* opponent hands */}
      {layout.opponentCards.map((c) => {
        const seat = layout.seats[c.seatIndex]!;
        const known = view.knownCards[c.cardId];
        return (
          <CardMesh
            key={c.cardId}
            instance={{ ...c, lifted: liftIds.has(c.cardId) || c.lifted }}
            revealedRank={known?.rank ?? null}
            revealedSuit={known?.suit ?? null}
            selectable={props.opponentSelectable(seat.playerId)}
            highlight={false}
            backSku={loadouts[seat.playerId]?.cardBack}
            onClick={props.opponentSelectable(seat.playerId) ? () => props.onOpponentCardClick(seat.playerId, c.cardId) : undefined}
          />
        );
      })}

      {/* my hand */}
      {layout.myCards.map((c) => {
        const known = view.knownCards[c.cardId];
        return (
          <CardMesh
            key={c.cardId}
            instance={{ ...c, lifted: liftIds.has(c.cardId) || c.lifted }}
            revealedRank={known?.rank ?? null}
            revealedSuit={known?.suit ?? null}
            selectable
            highlight={props.selectedOwn === c.cardId}
            backSku={myBack}
            onClick={() => props.onMyCardClick(c.cardId)}
          />
        );
      })}

      {/* turn ring under the active seat */}
      {(() => {
        const active = view.players.find((p) => p.isCurrentTurn);
        if (!active) return null;
        const seat = active.id === myId ? layout.me : layout.seats.find((s) => s.playerId === active.id);
        if (!seat) return null;
        return (
          <mesh position={[seat.pos.x, 0.012, seat.pos.z]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.62, 0.72, 48]} />
            <meshBasicMaterial color="#ffd88a" transparent opacity={0.75} />
          </mesh>
        );
      })()}

      {/* seat pills */}
      {layout.seats.map((seat, i) => {
        const player = view.players.find((p) => p.id === seat.playerId);
        if (!player) return null;
        const lobbyPlayer = room.lobby?.players.find((lp) => lp.id === seat.playerId);
        return (
          <SeatPill
            key={seat.playerId}
            seat={seat}
            name={player.name}
            isTurn={player.isCurrentTurn}
            glowing={(mode === 'power-peek-other' || mode === 'power-blind-swap') && !props.targetPlayer}
            emote={room.emotes[seat.playerId]}
            avatar={lobbyPlayer?.avatar ?? { color: i, eyes: 0, mouth: 0, hat: 0 }}
            isHostMe={room.lobby?.hostId === myId}
            humanSeat={lobbyPlayer?.kind !== 'ai'}
            caboCaller={view.cabo?.callerId === seat.playerId}
            onClick={() => props.onOpponentClick(seat.playerId)}
            onKick={room.lobby?.hostId === myId && lobbyPlayer?.kind !== 'ai' ? () => room.kickLive(seat.playerId) : undefined}
            onReport={() => room.reportPlayer(seat.playerId, 'reported at table')}
          />
        );
      })}

      {/* flight ghosts */}
      {flights.map((f) => (
        <FlightGhost key={f.id} flight={f} layout={layout} onDone={props.onFlightDone} />
      ))}
    </>
  );
}

// Public component: wraps the canvas. Loaded via React.lazy so the three.js
// bundle stays out of the main chunk.
export default function CaboScene(props: CaboSceneProps) {
  return (
    <div className="scene3d-host">
      <Canvas
        dpr={[1, 1.75]}
        gl={{ alpha: true, antialias: true }}
        camera={{ position: [0, 6.4, 5.4], fov: 42 }}
        onPointerMissed={() => {
          document.body.style.cursor = 'auto';
        }}
      >
        <Suspense fallback={null}>
          <SceneContents {...props} />
        </Suspense>
      </Canvas>
    </div>
  );
}
