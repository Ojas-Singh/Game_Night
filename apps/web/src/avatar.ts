/**
 * Skribbl-style customizable avatars: option lists shared by the picker and
 * the renderer, plus local persistence so your look survives across rooms.
 */

import type { Avatar } from './server-protocol.js';

export const AVATAR_COLORS = [
  '#e8b04b', // gold
  '#d9704a', // terracotta
  '#b6533c', // brick
  '#7a9a5c', // moss
  '#4f8a8b', // teal
  '#5b7db1', // slate blue
  '#7b6aa8', // violet
  '#a85b8f', // plum
  '#c98bab', // rose
  '#8d6e63', // cocoa
  '#90a4ae', // steel
  '#546e7a', // storm
];

export const EYE_STYLES = ['round', 'happy', 'sleepy', 'wink', 'wide', 'star'] as const;
export const MOUTH_STYLES = ['smile', 'grin', 'smirk', 'open', 'neutral', 'tongue'] as const;
export const HAT_STYLES = ['none', 'cap', 'crown', 'beanie', 'tophat', 'flower'] as const;

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
