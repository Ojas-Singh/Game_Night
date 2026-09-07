/** MediaMesh unit tests — mesh membership + signaling rate limiting. */

import { describe, expect, it } from 'vitest';
import { MediaMesh } from '../src/media.js';

describe('MediaMesh', () => {
  it('joins members and excludes the joiner from their own roster', () => {
    const mesh = new MediaMesh();
    const others = mesh.join('r1', 'a', 'sa', { mic: true, cam: false });
    expect(others).toHaveLength(0);
    const others2 = mesh.join('r1', 'b', 'sb', { mic: true, cam: true });
    expect(others2).toHaveLength(1);
    expect(others2[0]).toMatchObject({ playerId: 'a', mic: true, cam: false });
    expect(mesh.members('r1')).toHaveLength(2);
  });

  it('treats multiple sockets as one member until the last socket leaves', () => {
    const mesh = new MediaMesh();
    mesh.join('r1', 'a', 's1', { mic: true, cam: true });
    mesh.join('r1', 'a', 's2', { mic: false, cam: false });
    // Latest toggles win.
    expect(mesh.members('r1')[0]).toMatchObject({ mic: false, cam: false });
    expect(mesh.leaveSocket('r1', 'a', 's1')).toBe(false);
    expect(mesh.members('r1')).toHaveLength(1);
    expect(mesh.leaveSocket('r1', 'a', 's2')).toBe(true);
    expect(mesh.members('r1')).toHaveLength(0);
  });

  it('updates toggles only for existing members and removes on kick', () => {
    const mesh = new MediaMesh();
    mesh.join('r1', 'a', 's1', { mic: true, cam: false });
    mesh.update('r1', 'a', { mic: false, cam: true });
    expect(mesh.members('r1')[0]).toMatchObject({ mic: false, cam: true });
    mesh.update('r1', 'ghost', { mic: true, cam: true }); // no-op
    expect(mesh.members('r1')).toHaveLength(1);
    expect(mesh.removeMember('r1', 'a')).toBe(true);
    expect(mesh.removeMember('r1', 'a')).toBe(false);
  });

  it('rate limits signaling per socket with a refill budget', () => {
    const mesh = new MediaMesh();
    const t0 = 1_000_000;
    // Burst allowance is 120 tokens.
    for (let i = 0; i < 120; i++) expect(mesh.allowSignal('sx', t0)).toBe(true);
    expect(mesh.allowSignal('sx', t0)).toBe(false);
    // Half a second refills ~30 tokens.
    for (let i = 0; i < 30; i++) expect(mesh.allowSignal('sx', t0 + 500)).toBe(true);
    expect(mesh.allowSignal('sx', t0 + 500)).toBe(false);
    // Sockets are independent; forgetting clears the bucket.
    expect(mesh.allowSignal('sy', t0)).toBe(true);
    mesh.forgetSocket('sx');
    expect(mesh.allowSignal('sx', t0 + 500)).toBe(true);
  });
});
