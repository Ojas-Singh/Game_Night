import type { Avatar as AvatarModel } from '../server-protocol.js';
import { AVATAR_COLORS, EYE_STYLES, MOUTH_STYLES, HAT_STYLES } from '../avatar.js';

/**
 * A skribbl-style avatar: a coloured round face with selectable eyes, mouth
 * and hat. Rendered as inline SVG so it scales crisply anywhere (lobby list,
 * seats around the table). An optional crown marks whose turn it is.
 */
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
  const color = AVATAR_COLORS[avatar.color] ?? AVATAR_COLORS[0]!;
  const eyes = EYE_STYLES[avatar.eyes] ?? 'round';
  const mouth = MOUTH_STYLES[avatar.mouth] ?? 'smile';
  const hat = HAT_STYLES[avatar.hat] ?? 'none';
  return (
    <span
      className={`avatar ${ring ? 'ring' : ''} ${crown ? 'has-crown' : ''} ${cabo ? 'cabo' : ''}`}
      style={{ width: size, height: size }}
      title={cabo ? 'Called Cabo!' : undefined}
    >
      {crown && <span className="avatar-crown">👑</span>}
      {cabo && <span className="avatar-cabo-badge">🔔</span>}
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        {/* head */}
        <circle cx="50" cy="54" r="38" fill={color} stroke="rgba(36,20,9,0.35)" strokeWidth="3" />
        <ellipse cx="38" cy="42" rx="12" ry="8" fill="rgba(255,255,255,0.22)" />
        {/* eyes */}
        {renderEyes(eyes)}
        {/* mouth */}
        {renderMouth(mouth)}
        {/* hat */}
        {renderHat(hat)}
      </svg>
    </span>
  );
}

function renderEyes(style: string) {
  switch (style) {
    case 'happy':
      return (
        <g stroke="#241409" strokeWidth="4" strokeLinecap="round" fill="none">
          <path d="M30 52 q7 -8 14 0" />
          <path d="M56 52 q7 -8 14 0" />
        </g>
      );
    case 'sleepy':
      return (
        <g stroke="#241409" strokeWidth="4" strokeLinecap="round" fill="none">
          <path d="M30 52 h14" />
          <path d="M56 52 h14" />
        </g>
      );
    case 'wink':
      return (
        <g stroke="#241409" strokeWidth="4" strokeLinecap="round" fill="none">
          <path d="M56 50 h14" />
          <circle cx="37" cy="50" r="4.5" fill="#241409" stroke="none" />
        </g>
      );
    case 'wide':
      return (
        <g fill="#fff" stroke="#241409" strokeWidth="3">
          <circle cx="37" cy="50" r="8" />
          <circle cx="63" cy="50" r="8" />
          <circle cx="37" cy="50" r="3.4" fill="#241409" stroke="none" />
          <circle cx="63" cy="50" r="3.4" fill="#241409" stroke="none" />
        </g>
      );
    case 'star':
      return (
        <g fill="#241409">
          <path d="M37 42 l2.6 5.6 6 .6 -4.5 4 1.3 6 -5.4-3.2 -5.4 3.2 1.3-6 -4.5-4 6-.6 z" />
          <path d="M63 42 l2.6 5.6 6 .6 -4.5 4 1.3 6 -5.4-3.2 -5.4 3.2 1.3-6 -4.5-4 6-.6 z" />
        </g>
      );
    default: // round
      return (
        <g fill="#241409">
          <circle cx="37" cy="50" r="4.5" />
          <circle cx="63" cy="50" r="4.5" />
        </g>
      );
  }
}

function renderMouth(style: string) {
  switch (style) {
    case 'grin':
      return (
        <g>
          <path d="M36 66 q14 12 28 0 z" fill="#241409" />
          <path d="M36 66 h28" stroke="#fff" strokeWidth="4" />
        </g>
      );
    case 'smirk':
      return <path d="M42 68 q12 4 20 -4" stroke="#241409" strokeWidth="4" strokeLinecap="round" fill="none" />;
    case 'open':
      return <ellipse cx="50" cy="68" rx="8" ry="6.5" fill="#241409" />;
    case 'neutral':
      return <path d="M40 68 h20" stroke="#241409" strokeWidth="4" strokeLinecap="round" />;
    case 'tongue':
      return (
        <g>
          <path d="M38 64 q12 12 24 0 z" fill="#241409" />
          <path d="M46 70 q4 6 8 0 z" fill="#d9704a" />
        </g>
      );
    default: // smile
      return <path d="M38 64 q12 12 24 0" stroke="#241409" strokeWidth="4" strokeLinecap="round" fill="none" />;
  }
}

function renderHat(style: string) {
  switch (style) {
    case 'cap':
      return (
        <g>
          <path d="M22 30 a28 20 0 0 1 56 0 z" fill="#5b7db1" stroke="rgba(36,20,9,0.4)" strokeWidth="2.5" />
          <path d="M50 12 h34 a6 6 0 0 1 0 8 h-34 z" fill="#4f6a96" />
        </g>
      );
    case 'crown':
      return (
        <g>
          <path d="M30 26 l6 -14 8 9 6 -14 6 14 8 -9 6 14 z" fill="#e8b04b" stroke="#a9762f" strokeWidth="2.5" />
          <circle cx="50" cy="20" r="3" fill="#d9704a" />
        </g>
      );
    case 'beanie':
      return (
        <g>
          <path d="M24 32 a26 22 0 0 1 52 0 z" fill="#b6533c" stroke="rgba(36,20,9,0.4)" strokeWidth="2.5" />
          <rect x="22" y="30" width="56" height="9" rx="4.5" fill="#e8ddc4" />
          <circle cx="50" cy="8" r="5" fill="#e8ddc4" />
        </g>
      );
    case 'tophat':
      return (
        <g>
          <rect x="26" y="24" width="48" height="6" rx="3" fill="#37474f" />
          <rect x="34" y="2" width="32" height="24" rx="3" fill="#37474f" />
          <rect x="34" y="18" width="32" height="7" fill="#e8b04b" />
        </g>
      );
    case 'flower':
      return (
        <g>
          {[0, 72, 144, 216, 288].map((a) => (
            <ellipse
              key={a}
              cx="50"
              cy="12"
              rx="5.5"
              ry="8"
              fill="#c98bab"
              transform={`rotate(${a} 50 20)`}
            />
          ))}
          <circle cx="50" cy="20" r="4.5" fill="#e8b04b" />
        </g>
      );
    default:
      return null;
  }
}
