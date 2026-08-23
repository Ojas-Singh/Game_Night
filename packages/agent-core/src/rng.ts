/**
 * Deterministic RNG shared by the arena and agents.
 * mulberry32 — tiny, fast, good enough distribution for game simulation.
 */

export interface RngLike {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: T[]): T[];
}

export function createAgentRng(seed: number): RngLike {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (maxExclusive: number) => Math.floor(next() * maxExclusive),
    pick: <T,>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('rng.pick on empty list');
      return items[Math.floor(next() * items.length)]!;
    },
    shuffle: <T,>(items: T[]): T[] => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [items[i], items[j]] = [items[j]!, items[i]!];
      }
      return items;
    },
  };
}
