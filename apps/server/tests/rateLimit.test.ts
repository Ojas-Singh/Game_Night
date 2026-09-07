/** Token bucket + per-socket registry tests. */

import { describe, expect, it } from 'vitest';
import { SocketRateLimits, TokenBucket } from '../src/rateLimit.js';

describe('TokenBucket', () => {
  it('allows a burst up to capacity then throttles', () => {
    const bucket = new TokenBucket(3, 1);
    const t0 = 1_000_000;
    expect(bucket.allow(t0)).toBe(true);
    expect(bucket.allow(t0)).toBe(true);
    expect(bucket.allow(t0)).toBe(true);
    expect(bucket.allow(t0)).toBe(false); // burst exhausted
  });

  it('refills over time and caps at capacity', () => {
    const bucket = new TokenBucket(2, 10); // 10/s
    const t0 = 1_000_000;
    expect(bucket.allow(t0)).toBe(true);
    expect(bucket.allow(t0)).toBe(true);
    expect(bucket.allow(t0)).toBe(false);
    expect(bucket.allow(t0 + 100)).toBe(true); // 1 token refilled after 100ms
    expect(bucket.allow(t0 + 100)).toBe(false);
    expect(bucket.allow(t0 + 60_000)).toBe(true); // capped, still ≥1
  });
});

describe('SocketRateLimits', () => {
  it('tracks kinds per socket independently', () => {
    const limits = new SocketRateLimits({ chat: () => new TokenBucket(1, 1000) });
    expect(limits.allow('s1', 'chat')).toBe(true);
    expect(limits.allow('s1', 'chat')).toBe(false);
    expect(limits.allow('s2', 'chat')).toBe(true); // other socket unaffected
    expect(limits.allow('s1', 'emote')).toBe(true); // unknown kind passes through
  });

  it('forgets sockets and sweeps idle ones', () => {
    const limits = new SocketRateLimits({ chat: () => new TokenBucket(1, 0.001) });
    const t0 = 2_000_000;
    expect(limits.allow('s1', 'chat', t0)).toBe(true);
    limits.forget('s1');
    expect(limits.allow('s1', 'chat', t0)).toBe(true); // fresh bucket after forget
    limits.allow('s2', 'chat', t0);
    limits.allow('s3', 'chat', t0 + 1000);
    // s1 (idle 2000ms), s2 (2000ms) and s3 (1000ms) all exceed the 500ms ttl.
    expect(limits.sweep(500, t0 + 2000)).toBe(3);
  });
});
