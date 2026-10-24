/**
 * Storybook-folk avatars: option lists shared by the picker and
 * the renderer, plus local persistence so your look survives across rooms.
 */

import type { Avatar } from './server-protocol.js';

/** Coat colour per look; each index also picks a skin tone and hair colour
 *  (CHARACTER_TONES in table/Avatar.tsx). */
export const AVATAR_COLORS = [
  '#a8432a', // rust
  '#d27a2c', // pumpkin
  '#c9a23a', // mustard
  '#6f7d3c', // moss
  '#3f6f6c', // pond teal
  '#2f4462', // night blue
  '#6a4a78', // plum
  '#7c2a33', // berry
  '#6b4a2e', // bark
  '#5c6670', // slate
  '#8a8a52', // reed
  '#2e2a2b', // charcoal
];

export const EYE_STYLES = ['dots', 'happy', 'sleepy', 'wink', 'wide', 'star'] as const;
export const MOUTH_STYLES = ['smile', 'grin', 'smirk', 'oh', 'flat', 'tongue'] as const;
export const HAT_STYLES = ['none', 'cone', 'teapot', 'toque', 'stovepipe', 'bluebird'] as const;

export const DEFAULT_AVATAR: Avatar = { color: 0, eyes: 0, mouth: 0, hat: 0 };

const STORE_KEY = 'gn:avatar';

export function loadAvatar(): Avatar {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_AVATAR };
    const v = JSON.parse(raw) as Record<string, unknown>;
    const num = (x: unknown, max: number) =>
      typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < max ? x : 0;
    return {
      color: num(v.color, AVATAR_COLORS.length),
      eyes: num(v.eyes, EYE_STYLES.length),
      mouth: num(v.mouth, MOUTH_STYLES.length),
      hat: num(v.hat, HAT_STYLES.length),
    };
  } catch {
    return { ...DEFAULT_AVATAR };
  }
}

export function saveAvatar(a: Avatar): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(a));
  } catch {
    /* private mode — ignore */
  }
}

/** Pick a complete look for the lobby's “Surprise me” action. */
export function randomAvatar(): Avatar {
  const pick = (length: number) => Math.floor(Math.random() * length);
  return {
    color: pick(AVATAR_COLORS.length),
    eyes: pick(EYE_STYLES.length),
    mouth: pick(MOUTH_STYLES.length),
    hat: pick(HAT_STYLES.length),
  };
}
