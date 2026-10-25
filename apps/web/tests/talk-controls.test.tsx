/**
 * Table-talk controls + ICE config parsing (UI-level; real media needs a
 * browser — the mesh behaviour is covered by the two-peer verification run).
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TalkControls, { PeerAudioSinks } from '../src/table/TalkControls.js';
import { parseIceServers } from '../src/useMediaChat.js';
import type { MediaChat } from '../src/useMediaChat.js';

function fakeMedia(overrides: Partial<MediaChat> = {}): MediaChat {
  return {
    supported: true,
    joined: false,
    micOn: false,
    camOn: false,
    error: null,
    peers: [],
    speaking: new Set<string>(),
    localStream: null,
    join: async () => true,
    leave: () => undefined,
    setMic: () => undefined,
    setCam: async () => true,
    ...overrides,
  };
}

describe('parseIceServers', () => {
  it('falls back to a public STUN server', () => {
    const servers = parseIceServers(undefined);
    expect(servers).toHaveLength(1);
    expect(String(servers[0]!.urls)).toContain('stun:');
  });

  it('parses a configured list and rejects garbage', () => {
    expect(parseIceServers('[{"urls":"turn:turn.example.test"}]')).toEqual([{ urls: 'turn:turn.example.test' }]);
    expect(parseIceServers('not json')).toHaveLength(1);
    expect(parseIceServers('{"urls":"x"}')).toHaveLength(1); // not an array
    expect(parseIceServers('[{"nope":true}]')).toHaveLength(1); // no urls
  });
});

describe('TalkControls', () => {
  it('offers voice and voice+video before the call, with SVG icons and no emoji', () => {
    const markup = renderToStaticMarkup(
      <TalkControls media={fakeMedia()} playerId="host" isYou />,
    );
    expect(markup).toContain('Join table talk with voice');
    expect(markup).toContain('Join table talk with voice and video');
    expect(markup).toContain('<svg');
    // The old controls shipped emoji; they must not come back.
    expect(markup).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it('renders mic, camera and leave toggles once joined', () => {
    const markup = renderToStaticMarkup(
      <TalkControls media={fakeMedia({ joined: true, micOn: true, camOn: false })} playerId="host" isYou />,
    );
    expect(markup).toContain('Mute your mic');
    expect(markup).toContain('Turn your camera on');
    expect(markup).toContain('Leave table talk');
    expect(markup).toContain('aria-pressed="true"');
  });

  it('gives a peer row live state only, never controls', () => {
    const markup = renderToStaticMarkup(
      <TalkControls
        media={fakeMedia({
          joined: true,
          micOn: true,
          camOn: true,
          peers: [{ playerId: 'p2', mic: false, cam: true, stream: null, videoStream: null, connection: 'connected', speaking: true }],
        })}
        playerId="p2"
        isYou={false}
      />,
    );
    expect(markup).toContain('talk-dot speaking');
    expect(markup).toContain('Microphone off');
    expect(markup).not.toContain('Mute your mic');
  });

  it('hides itself entirely when the browser cannot do media', () => {
    const markup = renderToStaticMarkup(
      <TalkControls media={fakeMedia({ supported: false })} playerId="host" isYou />,
    );
    expect(markup).toBe('');
  });
});

describe('PeerAudioSinks', () => {
  it('attaches each peer audio exactly once', () => {
    const markup = renderToStaticMarkup(
      <PeerAudioSinks
        media={fakeMedia({
          joined: true,
          peers: [
            { playerId: 'p2', mic: true, cam: false, stream: null, videoStream: null, connection: 'connected', speaking: false },
            { playerId: 'p3', mic: true, cam: false, stream: null, videoStream: null, connection: 'connected', speaking: false },
          ],
        })}
      />,
    );
    expect(markup.match(/<audio/g)).toHaveLength(2);
  });

  it('attaches one audio sink per peer, and a hidden video sink only when asked', () => {
    const peers = [
      { playerId: 'p2', mic: true, cam: true, stream: null, videoStream: {} as MediaStream, connection: 'connected' as const, speaking: false },
      { playerId: 'p3', mic: true, cam: false, stream: null, videoStream: null, connection: 'connected' as const, speaking: false },
    ];
    const markup = renderToStaticMarkup(<PeerAudioSinks media={fakeMedia({ joined: true, peers })} />);
    expect(markup.match(/<audio/g)).toHaveLength(2);

    // No hidden video unless a caller asks for it: seats render their own video.
    expect(markup).not.toContain('talk-hidden-video');
    const withVideo = renderToStaticMarkup(<PeerAudioSinks media={fakeMedia({ joined: true, peers })} video />);
    expect(withVideo.match(/talk-hidden-video/g)).toHaveLength(1);
  });
});
