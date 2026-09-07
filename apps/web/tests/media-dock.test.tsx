/** Media dock + ICE config parsing (UI-level; real media needs a browser). */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MediaDock from '../src/table/MediaDock.js';
import { parseIceServers } from '../src/useMediaChat.js';
import type { MediaChat } from '../src/useMediaChat.js';
import type { LobbyPlayer } from '../src/server-protocol.js';

const players: LobbyPlayer[] = [
  { id: 'host', name: 'Host', isHost: true, ready: true, connected: true, isYou: true, avatar: { color: 0, eyes: 0, mouth: 0, hat: 0 } },
  { id: 'ai-1', name: 'AI Scholar', isHost: false, ready: true, connected: true, isYou: false, kind: 'ai', avatar: { color: 1, eyes: 0, mouth: 0, hat: 0 } },
];

function fakeMedia(overrides: Partial<MediaChat> = {}): MediaChat {
  return {
    supported: true,
    joined: false,
    micOn: false,
    camOn: false,
    error: null,
    peers: [],
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

describe('MediaDock', () => {
  it('offers voice and voice+video joins before the call', () => {
    const markup = renderToStaticMarkup(
      <MediaDock media={fakeMedia()} players={players} myPlayerId="host" />,
    );
    expect(markup).toContain('Voice');
    expect(markup).toContain('Voice + video');
    expect(markup).toContain('peer-to-peer');
  });

  it('renders live controls and peer tiles while joined', () => {
    const markup = renderToStaticMarkup(
      <MediaDock
        media={fakeMedia({
          joined: true,
          micOn: true,
          camOn: false,
          peers: [{ playerId: 'p2', mic: false, cam: true, stream: null, connection: 'connected', speaking: true }],
        })}
        players={players}
        myPlayerId="host"
      />,
    );
    expect(markup).toContain('Mic on');
    expect(markup).toContain('Cam off');
    expect(markup).toContain('Leave');
    expect(markup).toContain('media-peer speaking');
    expect(markup).toContain('🔇'); // peer mic off marker
  });

  it('hides itself entirely when the browser cannot do media', () => {
    const markup = renderToStaticMarkup(
      <MediaDock media={fakeMedia({ supported: false })} players={players} myPlayerId="host" />,
    );
    expect(markup).toBe('');
  });
});
