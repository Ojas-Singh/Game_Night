/** Analytics helper: no-op without config, bounded payloads when enabled. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureAnalytics, track } from '../src/analytics.js';

describe('analytics', () => {
  afterEach(() => {
    configureAnalytics();
    vi.restoreAllMocks();
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  });

  function withWindow(umami: unknown): void {
    (globalThis as { window?: unknown }).window = { umami };
  }

  it('is a no-op when disabled', () => {
    configureAnalytics(null);
    const spy = vi.fn();
    withWindow({ track: spy });
    expect(() => track('home_view')).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('forwards bounded events to umami when configured', () => {
    configureAnalytics({ src: 'https://stats.example.test/script.js', websiteId: 'abc123' });
    const spy = vi.fn();
    withWindow({ track: spy });
    track('game_start', { gameId: 'cabo' });
    expect(spy).toHaveBeenCalledWith('game_start', { gameId: 'cabo' });
  });

  it('never throws when umami itself is absent', () => {
    configureAnalytics({ src: 'https://stats.example.test/script.js', websiteId: 'abc123' });
    withWindow(undefined);
    expect(() => track('shop_open')).not.toThrow();
  });
});
