import { useMemo } from 'react';
import type { Avatar as AvatarModel } from '../server-protocol.js';
import { AVATAR_COLORS, EYE_STYLES, MOUTH_STYLES, HAT_STYLES } from '../avatar.js';

/**
 * A little storybook character in a parchment roundel: long-ish face, big
 * round nose, rosy cheeks, dot eyes, a coat and (optionally) a hat — a cone
 * cap, a tin teapot, a knit toque, a stovepipe or a bluebird perched on top.
 *
 * Every outline is generated in JavaScript with a seeded wobble and drawn
 * twice (a firm stroke plus a faint offset one), so the figures read as hand
 * inked. The wobble is seeded from the look, so a player's face is stable.
 * Large avatars (the lobby preview) ink themselves in when they appear.
 */

/** skin, hair, cheek — paired with the coat colour of the same index. */
const CHARACTER_TONES: Array<{ skin: string; hair: string; cheek: string }> = [
  { skin: '#f2d2b0', hair: '#5a3a22', cheek: '#e58f7a' },
  { skin: '#e9bf93', hair: '#2d1e16', cheek: '#dd7f68' },
  { skin: '#f4d9bd', hair: '#c4692b', cheek: '#ec9a85' },
  { skin: '#c68e63', hair: '#1f1612', cheek: '#c96a55' },
  { skin: '#f0cfab', hair: '#d8b36a', cheek: '#e8907c' },
  { skin: '#a8714a', hair: '#1c1310', cheek: '#b55c48' },
  { skin: '#f3d6b6', hair: '#8e8a86', cheek: '#e8957f' },
  { skin: '#e2b48a', hair: '#6b2f1c', cheek: '#d97864' },
  { skin: '#7d5236', hair: '#141010', cheek: '#a2503e' },
  { skin: '#ecc7a0', hair: '#47331f', cheek: '#e08a73' },
  { skin: '#d9a77c', hair: '#3a2a1e', cheek: '#cf735e' },
  { skin: '#f1cfae', hair: '#b04a22', cheek: '#e88f7b' },
];

const INK = '#2a1a10';

type Pt = [number, number];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n: number) => n.toFixed(1);

/** Smooth path through points (Catmull-Rom as cubic Béziers). */
function smooth(pts: Pt[], closed: boolean): string {
  if (pts.length < 2) return '';
  const p = (i: number): Pt => {
    if (closed) return pts[(i + pts.length) % pts.length]!;
    return pts[Math.max(0, Math.min(pts.length - 1, i))]!;
  };
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = p(i - 1);
    const [x1, y1] = p(i);
    const [x2, y2] = p(i + 1);
    const [x3, y3] = p(i + 2);
    d += ` C${f(x1 + (x2 - x0) / 6)} ${f(y1 + (y2 - y0) / 6)} ${f(x2 - (x3 - x1) / 6)} ${f(y2 - (y3 - y1) / 6)} ${f(x2)} ${f(y2)}`;
  }
  return closed ? `${d} Z` : d;
}

function jitter(pts: Pt[], r: () => number, amp: number): Pt[] {
  return pts.map(([x, y]) => [x + (r() - 0.5) * 2 * amp, y + (r() - 0.5) * 2 * amp]);
}

function ellipsePts(cx: number, cy: number, rx: number, ry: number, n = 12, start = 0): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = start + (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as Pt;
  });
}

interface Pen {
  /** A filled, inked closed shape. */
  shape: (pts: Pt[], fill: string, amp?: number, width?: number) => JSX.Element;
  /** An inked open line. */
  line: (pts: Pt[], amp?: number, width?: number, color?: string) => JSX.Element;
}

function makePen(seed: number): Pen {
  const r = rng(seed);
  let k = 0;
  const shape: Pen['shape'] = (pts, fill, amp = 1.1, width = 2.4) => {
    const main = smooth(jitter(pts, r, amp), true);
    const ghost = smooth(jitter(pts, r, amp * 1.4), true);
    k += 1;
    return (
      <g key={`s${k}`}>
        <path className="av-fill" d={main} fill={fill} />
        <path className="av-ink" pathLength={1} d={main} fill="none" stroke={INK} strokeWidth={width} strokeLinejoin="round" />
        <path className="av-ink ghost" pathLength={1} d={ghost} fill="none" stroke={INK} strokeWidth={width * 0.4} opacity={0.45} />
      </g>
    );
  };
  const line: Pen['line'] = (pts, amp = 0.8, width = 2.4, color = INK) => {
    k += 1;
    return (
      <path
        key={`l${k}`}
        className="av-ink"
        pathLength={1}
        d={smooth(jitter(pts, r, amp), false)}
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  };
  return { shape, line };
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
  return `rgb(${c((n >> 16) & 255)}, ${c((n >> 8) & 255)}, ${c(n & 255)})`;
}

function drawCharacter(avatar: AvatarModel): JSX.Element[] {
  const coat = AVATAR_COLORS[avatar.color] ?? AVATAR_COLORS[0]!;
  const tone = CHARACTER_TONES[avatar.color] ?? CHARACTER_TONES[0]!;
  const eyes = EYE_STYLES[avatar.eyes] ?? 'dots';
  const mouth = MOUTH_STYLES[avatar.mouth] ?? 'smile';
  const hat = HAT_STYLES[avatar.hat] ?? 'none';
  const pen = makePen(1 + avatar.color * 131 + avatar.eyes * 17 + avatar.mouth * 7 + avatar.hat * 3);
  const out: JSX.Element[] = [];

  // Coat and shoulders.
  out.push(pen.shape([[6, 104], [12, 88], [26, 78], [40, 74], [60, 74], [74, 78], [88, 88], [94, 104]], coat, 1.2));
  out.push(pen.line([[40, 75], [50, 88], [60, 75]], 0.6, 2));
  out.push(pen.shape(ellipsePts(50, 91, 2.6, 2.6, 6), '#e9c27a', 0.3, 1.4));
  // Neck.
  out.push(pen.shape([[44, 66], [56, 66], [57, 77], [43, 77]], shade(tone.skin, -0.06), 0.4, 2));
  // Hair behind the head (long at the sides).
  if (hat !== 'stovepipe') {
    out.push(pen.shape(ellipsePts(50, 47, 22, 23, 12), tone.hair, 1.4, 2));
  }
  // Ears, then the head itself: a little longer than wide.
  out.push(pen.shape(ellipsePts(30.5, 53, 3.6, 5, 8), tone.skin, 0.4, 2));
  out.push(pen.shape(ellipsePts(69.5, 53, 3.6, 5, 8), tone.skin, 0.4, 2));
  out.push(pen.shape(ellipsePts(50, 52, 19, 22.5, 14, 0.2), tone.skin, 1));
  // Fringe across the forehead.
  out.push(
    pen.shape(
      [[31, 46], [33, 35], [41, 29], [50, 27.5], [60, 29], [67, 35], [69, 46], [64, 40], [58, 43], [52, 38], [46, 42], [39, 38], [35, 44]],
      tone.hair,
      0.8,
      2,
    ),
  );
  // Rosy cheeks.
  out.push(<ellipse key="ck1" cx="38.5" cy="61" rx="5" ry="3.4" fill={tone.cheek} opacity="0.5" />);
  out.push(<ellipse key="ck2" cx="61.5" cy="61" rx="5" ry="3.4" fill={tone.cheek} opacity="0.5" />);

  // Eyes.
  const lx = 42.5;
  const rx = 57.5;
  const ey = 51.5;
  switch (eyes) {
    case 'happy':
      out.push(pen.line([[lx - 3.5, ey + 1], [lx, ey - 2.5], [lx + 3.5, ey + 1]], 0.3, 2.2));
      out.push(pen.line([[rx - 3.5, ey + 1], [rx, ey - 2.5], [rx + 3.5, ey + 1]], 0.3, 2.2));
      break;
    case 'sleepy':
      out.push(pen.line([[lx - 4, ey], [lx, ey + 1.6], [lx + 4, ey]], 0.3, 2.2));
      out.push(pen.line([[rx - 4, ey], [rx, ey + 1.6], [rx + 4, ey]], 0.3, 2.2));
      break;
    case 'wink':
      out.push(<circle key="e1" cx={lx} cy={ey} r="2.4" fill={INK} />);
      out.push(pen.line([[rx - 4, ey + 0.5], [rx, ey - 1.5], [rx + 4, ey + 0.5]], 0.3, 2.2));
      break;
    case 'wide':
      out.push(pen.shape(ellipsePts(lx, ey, 4.4, 4.8, 8), '#fbf3e0', 0.3, 1.6));
      out.push(pen.shape(ellipsePts(rx, ey, 4.4, 4.8, 8), '#fbf3e0', 0.3, 1.6));
      out.push(<circle key="p1" cx={lx + 0.6} cy={ey + 0.8} r="1.9" fill={INK} />);
      out.push(<circle key="p2" cx={rx + 0.6} cy={ey + 0.8} r="1.9" fill={INK} />);
      break;
    case 'star':
      for (const [k, cx] of [['s1', lx], ['s2', rx]] as const) {
        out.push(
          <path
            key={k}
            d={`M${cx} ${ey - 4} L${cx + 1.2} ${ey - 1.2} L${cx + 4} ${ey} L${cx + 1.2} ${ey + 1.2} L${cx} ${ey + 4} L${cx - 1.2} ${ey + 1.2} L${cx - 4} ${ey} L${cx - 1.2} ${ey - 1.2} Z`}
            fill={INK}
          />,
        );
      }
      break;
    default:
      out.push(<circle key="e1" cx={lx} cy={ey} r="2.3" fill={INK} />);
      out.push(<circle key="e2" cx={rx} cy={ey} r="2.3" fill={INK} />);
  }
  // Brows give the face its storybook worry.
  out.push(pen.line([[lx - 4, ey - 6.5], [lx + 3, ey - 7.5]], 0.4, 1.6));
  out.push(pen.line([[rx - 3, ey - 7.5], [rx + 4, ey - 6.5]], 0.4, 1.6));

  // The big round nose.
  out.push(pen.shape(ellipsePts(50, 58, 4.8, 4.4, 8), shade(tone.skin, -0.08), 0.4, 2));
  out.push(<ellipse key="nh" cx="48.6" cy="56.6" rx="1.4" ry="1" fill="#fff" opacity="0.5" />);

  // Mouth.
  const my = 66.5;
  switch (mouth) {
    case 'grin':
      out.push(pen.shape([[42, my - 1], [58, my - 1], [55, my + 4], [50, my + 5.5], [45, my + 4]], '#5a2418', 0.3, 1.8));
      out.push(pen.line([[43.5, my], [56.5, my]], 0.2, 2, '#fbf3e0'));
      break;
    case 'smirk':
      out.push(pen.line([[44, my + 1], [51, my + 2], [57, my - 1.5]], 0.4, 2));
      break;
    case 'oh':
      out.push(pen.shape(ellipsePts(50, my + 1.5, 2.8, 3.4, 8), '#5a2418', 0.3, 1.8));
      break;
    case 'flat':
      out.push(pen.line([[45, my + 1], [55, my + 1]], 0.4, 2));
      break;
    case 'tongue':
      out.push(pen.line([[43, my], [50, my + 3.5], [57, my]], 0.4, 2));
      out.push(pen.shape([[48, my + 2.5], [52.5, my + 2.5], [52, my + 6], [48.5, my + 6]], '#d9705f', 0.3, 1.4));
      break;
    default:
      out.push(pen.line([[43.5, my - 0.5], [50, my + 3.5], [56.5, my - 0.5]], 0.4, 2));
  }

  // Hats.
  switch (hat) {
    case 'cone': {
      // A tall pointed cap that flops back at the tip.
      out.push(pen.shape([[27, 37], [36, 22], [46, 8], [58, -2], [66, 2], [60, 12], [67, 24], [73, 37], [50, 33]], '#b0402a', 1));
      out.push(pen.line([[29, 35], [50, 31], [71, 35]], 0.5, 2));
      break;
    }
    case 'teapot': {
      // A dented tin teapot worn as a hat.
      out.push(pen.line([[33, 27], [24, 22], [19, 13]], 0.5, 4.5, INK));
      out.push(pen.line([[33, 27], [24, 22], [19, 13]], 0.5, 2.6, '#b9b3a4'));
      out.push(pen.shape(ellipsePts(68, 21, 5.5, 7, 8), 'none', 0.5, 2.6));
      out.push(pen.shape([[32, 34], [33, 22], [40, 15], [50, 13], [60, 15], [67, 22], [68, 34], [50, 37]], '#b9b3a4', 0.8));
      out.push(pen.shape(ellipsePts(50, 13.5, 8.5, 3, 8), '#a49d8c', 0.4, 2));
      out.push(pen.shape(ellipsePts(50, 9, 2.6, 2.6, 6), '#a49d8c', 0.3, 1.8));
      out.push(pen.line([[38, 24], [41, 28]], 0.3, 1.2, '#7d776a'));
      break;
    }
    case 'toque': {
      const knit = shade(coat, 0.12);
      out.push(pen.shape([[28, 37], [30, 22], [40, 12], [50, 10], [60, 12], [70, 22], [72, 37]], knit, 1));
      out.push(pen.shape([[26, 33], [74, 33], [74, 40], [26, 40]], '#e8dcc0', 0.6, 2));
      for (const x of [36, 44, 52, 60]) out.push(pen.line([[x, 16], [x + 1, 32]], 0.5, 1.2, shade(knit, -0.2)));
      out.push(pen.shape(ellipsePts(50, 8, 5.5, 5.5, 8), '#e8dcc0', 0.8, 2));
      break;
    }
    case 'stovepipe': {
      out.push(pen.shape([[22, 34], [78, 34], [77, 39], [23, 39]], '#2b2626', 0.5, 2));
      out.push(pen.shape([[33, 35], [34, 3], [66, 3], [67, 35]], '#2b2626', 0.7, 2));
      out.push(pen.shape([[33.5, 26], [66.5, 26], [66.8, 32], [33.2, 32]], '#a8432a', 0.3, 1.6));
      break;
    }
    case 'bluebird': {
      // A small bluebird settled on top of the head.
      out.push(pen.shape([[38, 26], [44, 18], [54, 16], [62, 19], [66, 24], [62, 29], [50, 30]], '#4f78b0', 0.6, 2));
      out.push(pen.shape([[50, 22], [58, 21], [56, 27]], '#3a5d8f', 0.4, 1.4));
      out.push(pen.shape([[28, 26], [38, 24], [38, 28]], '#3a5d8f', 0.4, 1.6));
      out.push(pen.shape([[66, 22], [71, 23.5], [66, 25]], '#e2913c', 0.2, 1.4));
      out.push(<circle key="be" cx="62.5" cy="21.5" r="1.3" fill={INK} />);
      out.push(pen.shape([[58, 26], [65, 25.5], [63, 28.5]], '#e8a07a', 0.2, 1));
      break;
    }
    default:
      break;
  }
  return out;
}

export default function Avatar({
  avatar,
  size = 44,
  crown = false,
  ring = false,
  cabo = false,
}: {
  avatar: AvatarModel;
  size?: number;
  crown?: boolean;
  ring?: boolean;
  /** This player called Cabo — golden frame + bell badge until round end. */
  cabo?: boolean;
}) {
  const parts = useMemo(
    () => drawCharacter(avatar),
    [avatar.color, avatar.eyes, avatar.mouth, avatar.hat],
  );
  const clipId = useMemo(() => `av-clip-${Math.random().toString(36).slice(2, 9)}`, []);
  return (
    <span
      className={`avatar ${ring ? 'ring' : ''} ${crown ? 'has-crown' : ''} ${cabo ? 'cabo' : ''} ${size >= 64 ? 'av-inking' : ''}`}
      style={{ width: size, height: size }}
      title={cabo ? 'Called Cabo!' : undefined}
    >
      {crown && <span className="avatar-crown">👑</span>}
      {cabo && <span className="avatar-cabo-badge">🔔</span>}
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <defs>
          <clipPath id={clipId}>
            <circle cx="50" cy="50" r="49" />
          </clipPath>
          <radialGradient id={`${clipId}-bg`} cx="40%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#f7ead0" />
            <stop offset="100%" stopColor="#d8bf91" />
          </radialGradient>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <rect width="100" height="100" fill={`url(#${clipId}-bg)`} />
          {parts}
        </g>
        <circle cx="50" cy="50" r="48.5" fill="none" stroke={INK} strokeOpacity="0.55" strokeWidth="2" />
      </svg>
    </span>
  );
}
