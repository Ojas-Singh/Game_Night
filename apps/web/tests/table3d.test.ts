/** Pure 3D-table layout + texture descriptor tests (no WebGL needed). */

import { describe, expect, it } from 'vitest';
import {
  buildSceneLayout,
  canRun3d,
  CARD_H,
  flightAnchor,
  load3dPref,
  opponentAngle,
  save3dPref,
  seatPosition,
  seatRotationY,
} from '../src/table3d/layout.js';
import { cardFaceSpec, rankLabel, suitGlyph } from '../src/table3d/textures.js';
import type { CaboPlayerView } from '@cabo/views.js';

let seq = 0;
function fakeView(overrides: Partial<CaboPlayerView> = {}): CaboPlayerView {
  seq += 1;
  return {
    revision: seq,
    phase: 'TURN_DRAW',
    gameId: 'cabo',
    players: [
      { id: 'me', name: 'Me', cardCount: 2, isCurrentTurn: true },
      { id: 'p1', name: 'Left', cardCount: 2, isCurrentTurn: false },
      { id: 'p2', name: 'Top', cardCount: 2, isCurrentTurn: false },
    ],
    knownCards: { 'c-1': { id: 'c-1', suit: 'hearts', rank: 3 } },
    handCardIds: {
      me: ['c-1', '__slot__1'],
      p1: ['c-9', 'c-10'],
      p2: ['c-11', 'c-12'],
    },
    deckCount: 30,
    discardTop: { id: 'c-99', suit: 'spades', rank: 7 },
    events: [],
    pendingPower: null,
    pendingTransfer: null,
    drawnCard: null,
    needsInitialPeek: false,
    initialPeekCardIds: [],
    cabo: null,
    scores: null,
    roundWinnerId: null,
    tiedWinnerIds: [],
    discardTopRank: 7,
    ...overrides,
  };
}

describe('seat geometry', () => {
  it('fans opponents 20°..160° and centers a lone opponent', () => {
    expect(opponentAngle(0, 2)).toBe(20);
    expect(opponentAngle(1, 2)).toBe(160);
    expect(opponentAngle(0, 1)).toBe(90);
    expect(opponentAngle(0, 3)).toBe(20);
    expect(opponentAngle(2, 3)).toBe(160);
  });

  it('places the top seat above the origin and my seat below it', () => {
    const top = seatPosition(90);
    expect(top.x).toBeCloseTo(0, 6);
    expect(top.z).toBeLessThan(0);
    const layout = buildSceneLayout({ view: fakeView(), opponentIds: ['p1', 'p2'], myId: 'me' });
    expect(layout.me.pos.z).toBeGreaterThan(0);
  });

  it('rotates each fan so card tops point toward the centre', () => {
    const topRotation = seatRotationY(90);
    expect(Math.abs(topRotation)).toBeCloseTo(Math.PI, 6); // upside down from my view
    expect(seatRotationY(270)).toBeCloseTo(0, 6); // my seat reads upright
  });
});

describe('buildSceneLayout', () => {
  it('mirrors hand shapes with empty slots and knowledge-driven faces', () => {
    const layout = buildSceneLayout({ view: fakeView(), opponentIds: ['p1', 'p2'], myId: 'me' });
    expect(layout.seats).toHaveLength(2);
    expect(layout.myCards).toHaveLength(2);
    expect(layout.opponentCards).toHaveLength(4);
    const knownMine = layout.myCards.find((c) => c.cardId === 'c-1')!;
    const slotMine = layout.myCards.find((c) => c.cardId === '__slot__1')!;
    expect(knownMine.faceUp).toBe(true);
    expect(slotMine.emptySlot).toBe(true);
    expect(slotMine.faceUp).toBe(false);
    const unknown = layout.opponentCards.find((c) => c.cardId === 'c-9')!;
    expect(unknown.faceUp).toBe(false);
  });

  it('lifts selected cards above the table plane', () => {
    const layout = buildSceneLayout({
      view: fakeView(),
      opponentIds: ['p1', 'p2'],
      myId: 'me',
      liftedIds: new Set(['c-1']),
    });
    const lifted = layout.myCards.find((c) => c.cardId === 'c-1')!;
    const flat = layout.myCards.find((c) => c.cardId === '__slot__1')!;
    expect(lifted.pos.y).toBeGreaterThan(CARD_H * 0.3);
    expect(flat.pos.y).toBeLessThan(0.1);
  });

  it('keeps deck and discard piles apart and reports the deck size', () => {
    const layout = buildSceneLayout({ view: fakeView(), opponentIds: ['p1'], myId: 'me' });
    expect(layout.deckPos.x).toBeLessThan(layout.discardPos.x);
    expect(layout.deckCount).toBe(30);
  });
});

describe('flightAnchor', () => {
  const layout = buildSceneLayout({ view: fakeView(), opponentIds: ['p1', 'p2'], myId: 'me' });

  it('resolves piles, exact cards, seats, and falls back to centre', () => {
    expect(flightAnchor(layout, { pile: 'deck' })).toEqual(layout.deckPos);
    expect(flightAnchor(layout, { pile: 'discard' })).toEqual(layout.discardPos);
    expect(flightAnchor(layout, { pile: 'draw' })).toEqual(layout.drawnPos);
    const cardPos = flightAnchor(layout, { cardId: 'c-1' });
    expect(cardPos).toEqual(layout.myCards[0]!.pos);
    expect(flightAnchor(layout, { playerId: 'p2' })).toEqual(layout.seats[1]!.handCenter);
    expect(flightAnchor(layout, { playerId: 'me' })).toEqual(layout.me.handCenter);
    expect(flightAnchor(layout, {})).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('3D capability gate', () => {
  it('is SSR-safe and honours reduced motion', () => {
    expect(canRun3d()).toBe(false); // no window in the test env
  });

  it('persists an explicit preference over the capability default', () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as Record<string, unknown>;
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    g.matchMedia = () => ({ matches: false }) as MediaQueryList;
    g.window = { matchMedia: g.matchMedia };
    Object.defineProperty(g, 'navigator', { value: { hardwareConcurrency: 8 }, configurable: true });
    expect(load3dPref()).toBe(true); // capable default
    save3dPref(false);
    expect(load3dPref()).toBe(false); // explicit off wins
    store.set('game-night:table3d', 'on');
    expect(load3dPref()).toBe(true);
    store.set('game-night:table3d', 'garbage');
    expect(load3dPref()).toBe(true); // falls back to capability
    delete g.localStorage;
    delete g.matchMedia;
    delete g.window;
    // @ts-expect-error test global surgery
    delete g.navigator;
  });
});

describe('card face descriptors', () => {
  it('maps ranks and suits to labels, glyphs, and colours', () => {
    expect(rankLabel(1)).toBe('A');
    expect(rankLabel(11)).toBe('J');
    expect(rankLabel(7)).toBe('7');
    expect(cardFaceSpec({ rank: 12, suit: 'hearts' })).toEqual({ label: 'Q', glyph: '♥', red: true });
    expect(cardFaceSpec({ rank: 3, suit: 'spades' })).toEqual({ label: '3', glyph: '♠', red: false });
    expect(suitGlyph('clubs')).toBe('♣');
    expect(suitGlyph('mystery')).toBe('');
  });
});
