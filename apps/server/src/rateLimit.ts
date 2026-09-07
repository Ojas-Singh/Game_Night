/**
 * Token-bucket rate limiter for socket events (chat, emotes, reports).
 * Small, allocation-free, and unit-tested — the media mesh signaling relay
 * uses the same shape.
 */

export class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private capacity: number,
    private refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  /** Returns true when one token was consumed. */
  allow(now: number = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSecond);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/** Per-socket limiter registry that garbage-collects idle sockets. */
export class SocketRateLimits {
  private buckets = new Map<string, Record<string, TokenBucket>>();
  private lastTouch = new Map<string, number>();

  constructor(private factory: Record<string, () => TokenBucket>) {}

  allow(socketId: string, kind: string, now: number = Date.now()): boolean {
    this.lastTouch.set(socketId, now);
    let perSocket = this.buckets.get(socketId);
    if (!perSocket) {
      perSocket = {};
      this.buckets.set(socketId, perSocket);
    }
    let bucket = perSocket[kind];
    if (!bucket) {
      const make = this.factory[kind];
      if (!make) return true;
      bucket = make();
      perSocket[kind] = bucket;
    }
    return bucket.allow(now);
  }

  forget(socketId: string): void {
    this.buckets.delete(socketId);
    this.lastTouch.delete(socketId);
  }

  /** Drop sockets idle longer than ttlMs (call periodically). */
  sweep(ttlMs: number, now: number = Date.now()): number {
    let removed = 0;
    for (const [socketId, touch] of this.lastTouch) {
      if (now - touch > ttlMs) {
        this.forget(socketId);
        removed++;
      }
    }
    return removed;
  }
}
