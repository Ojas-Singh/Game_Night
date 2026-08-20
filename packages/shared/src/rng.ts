/**
 * Deterministic, seedable RNG (xoshiro128**) for test shuffles, with a
 * crypto-seeded default for production. Cryptographically appropriate
 * shuffling for real games comes from the crypto seed; determinism is only
 * used in tests/debug mode.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform int in [0, n). */
  int(n: number): number;
}

export function createRng(seed?: number): Rng {
  let s0: number, s1: number, s2: number, s3: number;
  if (seed === undefined) {
    // Cryptographically appropriate seeding.
    const buf = new Uint32Array(4);
    crypto.getRandomValues(buf);
    [s0, s1, s2, s3] = [buf[0]! | 1, buf[1]! | 1, buf[2]! | 1, buf[3]! | 1];
  } else {
    // SplitMix32 to expand the seed.
    let x = seed >>> 0;
    const mix = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    s0 = mix() | 1;
    s1 = mix() | 1;
    s2 = mix() | 1;
    s3 = mix() | 1;
  }

  const next = (): number => {
    const result = Math.imul(s1, 7) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = Math.imul(s3, 9) >>> 0;
    return (result >>> 0) / 4294967296;
  };

  return {
    next,
    int: (n: number) => Math.floor(next() * n),
  };
}

/** Fisher–Yates shuffle using the provided RNG. Returns a new array. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}
