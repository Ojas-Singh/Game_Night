/** AvatarCam: camera feed swaps into avatar circles (UI-level, jsdom-free). */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AvatarCam from '../src/table/AvatarCam.js';
import type { MediaChat } from '../src/useMediaChat.js';
import type { Avatar as AvatarSpec } from '../src/server-protocol.js';

const AVATAR: AvatarSpec = { color: 1, eyes: 0, mouth: 1, hat: 0 };

function fakeMedia(overrides: Partial<MediaChat> = {}): MediaChat {
  return {
    supported: true,
    joined: false,
    micOn: false,
    camOn: false,
    error: null,
    peers: [],
    localStream: null,
    join: async () => true,
    leave: () => undefined,
    setMic: () => undefined,
    setCam: async () => true,
    ...overrides,
  };
}

function fakeVideoStream(): MediaStream {
  // Server-side render never touches the stream; a truthy stand-in is enough.
  return { getVideoTracks: () => [] } as unknown as MediaStream;
}

describe('AvatarCam', () => {
  it('falls back to the classic avatar when there is no video', () => {
    const html = renderToStaticMarkup(<AvatarCam media={fakeMedia()} playerId="p2" avatar={AVATAR} />);
    expect(html).toContain('avatar'); // classic avatar svg/img
    expect(html).not.toContain('avatar-cam');
  });

  it('shows a live circle for a peer whose camera is on', () => {
    const stream = fakeVideoStream();
    const media = fakeMedia({
      joined: true,
      peers: [{ playerId: 'p2', mic: true, cam: true, stream, connection: 'connected', speaking: false }],
    });
    const html = renderToStaticMarkup(<AvatarCam media={media} playerId="p2" avatar={AVATAR} />);
    expect(html).toContain('avatar-cam');
    expect(html).toContain('<video');
    expect(html).toContain('autoplay'); // SSR renders the autoplay attribute
    expect(html).toContain('data-cam="on"');
  });

  it('drops back to the avatar when that peer mutes their camera', () => {
    const stream = fakeVideoStream();
    const media = fakeMedia({
      joined: true,
      peers: [{ playerId: 'p2', mic: true, cam: false, stream, connection: 'connected', speaking: false }],
    });
    const html = renderToStaticMarkup(<AvatarCam media={media} playerId="p2" avatar={AVATAR} />);
    expect(html).not.toContain('avatar-cam');
  });

  it('shows MY outbound camera in my own slot only', () => {
    const stream = fakeVideoStream();
    const media = fakeMedia({ joined: true, camOn: true, localStream: stream });
    const mine = renderToStaticMarkup(
      <AvatarCam media={media} playerId="me" myPlayerId="me" avatar={AVATAR} />,
    );
    expect(mine).toContain('avatar-cam');
    // Another seat must not see my stream:
    const other = renderToStaticMarkup(
      <AvatarCam media={media} playerId="p9" myPlayerId="me" avatar={AVATAR} />,
    );
    expect(other).not.toContain('avatar-cam');
  });
});
