//! Seedable random numbers for dealing, shuffling and sampling.
//!
//! Two generators share one state layout:
//!
//! * the default is xoshiro128++, used for self-play, search and live games;
//! * the `compat` generator reproduces the site's original TypeScript RNG
//!   (`packages/shared/src/rng.ts`) bit for bit, so a seed gives the same
//!   shuffle in both engines. It exists only to check ports move for move.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rng {
    s: [u32; 4],
    compat: bool,
}

fn expand_seed(seed: u32) -> [u32; 4] {
    // SplitMix32, with the low bit forced on as the TypeScript version does.
    let mut x = seed;
    let mut mix = || {
        x = x.wrapping_add(0x9e37_79b9);
        let mut z = x;
        z = (z ^ (z >> 16)).wrapping_mul(0x21f0_aaad);
        z = (z ^ (z >> 15)).wrapping_mul(0x735a_2d97);
        z ^ (z >> 15)
    };
    [mix() | 1, mix() | 1, mix() | 1, mix() | 1]
}

impl Rng {
    pub fn new(seed: u32) -> Self {
        let mut rng = Rng { s: expand_seed(seed), compat: false };
        // Decorrelate nearby seeds.
        for _ in 0..8 {
            rng.next_u32();
        }
        rng
    }

    /// Same stream as `createRng(seed)` in the TypeScript engines.
    pub fn ts_compat(seed: u32) -> Self {
        Rng { s: expand_seed(seed), compat: true }
    }

    pub fn from_u64(seed: u64) -> Self {
        let mut rng = Rng::new(seed as u32);
        rng.s[1] ^= (seed >> 32) as u32;
        rng.s[1] |= 1;
        for _ in 0..8 {
            rng.next_u32();
        }
        rng
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let [s0, s1, s2, s3] = &mut self.s;
        if self.compat {
            let result = s1.wrapping_mul(7);
            let t = *s1 << 9;
            *s2 ^= *s0;
            *s3 ^= *s1;
            *s1 ^= *s2;
            *s0 ^= *s3;
            *s2 ^= t;
            *s3 = s3.wrapping_mul(9);
            result
        } else {
            let result = s0.wrapping_add(*s3).rotate_left(7).wrapping_add(*s0);
            let t = *s1 << 9;
            *s2 ^= *s0;
            *s3 ^= *s1;
            *s1 ^= *s2;
            *s0 ^= *s3;
            *s2 ^= t;
            *s3 = s3.rotate_left(11);
            result
        }
    }

    /// Uniform integer in `0..n` (the same value as `Math.floor(next() * n)`).
    #[inline]
    pub fn int(&mut self, n: usize) -> usize {
        ((self.next_u32() as u64 * n as u64) >> 32) as usize
    }

    #[inline]
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1u32 << 24) as f32
    }

    /// A new, independent generator derived from this one.
    pub fn fork(&mut self) -> Rng {
        let a = self.next_u32() as u64;
        let b = self.next_u32() as u64;
        Rng::from_u64(a << 32 | b)
    }

    /// Fisher–Yates from the end, matching `shuffle` in the TypeScript code.
    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            let j = self.int(i + 1);
            items.swap(i, j);
        }
    }
}
