import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { iceServers } from '../src/ice.js';

describe('iceServers', () => {
  it('serves STUN only by default', () => {
    const list = iceServers({});
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list[0]!.urls)).toContain('stun:');
  });

  it('adds coturn REST credentials from TURN_URLS + TURN_SECRET', () => {
    const now = 1_700_000_000_000;
    const list = iceServers({ TURN_URLS: 'turn:a:3478, turn:a:3478?transport=tcp', TURN_SECRET: 's3' }, now);
    const turn = list[1]!;
    expect(turn.urls).toEqual(['turn:a:3478', 'turn:a:3478?transport=tcp']);
    expect(turn.username).toBe(`${now / 1000 + 12 * 3600}:gamenight`);
    expect(turn.credential).toBe(createHmac('sha1', 's3').update(turn.username!).digest('base64'));
  });

  it('passes ICE_SERVERS through and ignores malformed JSON', () => {
    expect(iceServers({ ICE_SERVERS: '[{"urls":"turn:x","username":"u","credential":"c"}]' })[1]).toMatchObject({ urls: 'turn:x' });
    expect(iceServers({ ICE_SERVERS: '{oops' })).toHaveLength(1);
  });
});
