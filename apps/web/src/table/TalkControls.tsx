/**
 * Table talk controls — one minimal icon row, used everywhere a player needs
 * to manage voice/video. Before joining it offers "voice" and "voice + video";
 * once live it becomes mic / camera / leave toggles.
 *
 * Peer audio and video elements are rendered from this component so that a
 * player's inbound media is always attached exactly once, no matter which
 * screen they are on.
 */

import { useEffect, useRef } from 'react';
import type { MediaChat, MediaPeer } from '../useMediaChat.js';
import { funnel } from '../analytics.js';
import { TalkIcon } from './TalkIcon.js';

/** Attach a stream to a media element, guarding against redundant assignment. */
function useAttachedStream(el: HTMLMediaElement | null, stream: MediaStream | null): void {
  if (el && stream && el.srcObject !== stream) el.srcObject = stream;
  if (el && !stream && el.srcObject) el.srcObject = null;
}

/**
 * Silent sink for one remote peer: carries their audio, and their video when
 * the player has no seat on screen to show it in.
 */
export function PeerMedia({ peer, video = false }: { peer: MediaPeer; video?: boolean }) {
  return (
    <>
      {/* Audio stream only — never the video-bearing one. */}
      <audio ref={(el) => useAttachedStream(el, peer.stream)} autoPlay playsInline />
      {video && peer.videoStream && (
        <video
          ref={(el) => useAttachedStream(el, peer.videoStream)}
          autoPlay
          playsInline
          className="talk-hidden-video"
          aria-hidden
        />
      )}
    </>
  );
}

/**
 * Renders the audio for every peer in the mesh, optionally with a hidden video
 * sink for peers whose picture has no seat on screen. Mount once per screen so
 * inbound media is never attached twice or dropped between routes.
 */
export function PeerAudioSinks({ media, video = false }: { media: MediaChat; video?: boolean }) {
  return (
    <div className="talk-sinks" aria-hidden>
      {media.peers.map((peer) => <PeerMedia key={peer.playerId} peer={peer} video={video} />)}
    </div>
  );
}

export default function TalkControls({
  media,
  playerId,
  isYou,
  variant = 'seat',
}: {
  media: MediaChat;
  playerId: string;
  isYou: boolean;
  /** `seat` sits inline next to a name; `bar` is a standalone control strip. */
  variant?: 'seat' | 'bar';
}) {
  const joined = media.joined;

  // Playback policy can block audio until a gesture; nudge on state changes.
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!joined) return;
    const el = rootRef.current;
    if (!el) return;
    for (const node of el.parentElement?.querySelectorAll('audio') ?? []) {
      void (node as HTMLAudioElement).play().catch(() => undefined);
    }
  }, [joined]);

  if (!media.supported) return null;

  // Somebody else's row: show only a live state hint, never controls.
  if (!isYou) {
    const peer = media.peers.find((p) => p.playerId === playerId);
    if (!media.joined || !peer) return null;
    return (
      <span className="talk-status" aria-hidden>
        {peer.connection === 'failed' && <span className="talk-flag" title="Direct connection failed (NAT)">⚠</span>}
        {peer.speaking && <span className="talk-dot speaking" title="Speaking" />}
        {!peer.mic && <span className="talk-mic-off" title="Microphone off"><TalkIcon name="micOff" size={13} /></span>}
        {!peer.cam && peer.stream && <span className="talk-cam-off" title="Camera off"><TalkIcon name="camOff" size={13} /></span>}
      </span>
    );
  }

  const join = (cam: boolean): void => {
    void media.join({ mic: true, cam }).then((ok) => {
      if (!ok) return;
      funnel.voiceJoined();
      if (cam) funnel.cameraEnabled();
    });
  };

  const rootClass = variant === 'bar' ? 'talk-bar' : 'talk-controls';

  return (
    <span className={rootClass} ref={rootRef}>
      {!joined ? (
        <>
          <button className="talk-btn" title="Join table talk (voice)" aria-label="Join table talk with voice" onClick={() => join(false)}>
            <TalkIcon name="mic" />
            {variant === 'bar' && <span>Voice</span>}
          </button>
          <button className="talk-btn" title="Join with camera" aria-label="Join table talk with voice and video" onClick={() => join(true)}>
            <TalkIcon name="cam" />
            {variant === 'bar' && <span>Voice + video</span>}
          </button>
        </>
      ) : (
        <>
          <button
            className={`talk-btn ${media.micOn ? 'on' : 'off'}`}
            title={media.micOn ? 'Mute your mic' : 'Unmute your mic'}
            aria-label={media.micOn ? 'Mute your mic' : 'Unmute your mic'}
            aria-pressed={media.micOn}
            onClick={() => media.setMic(!media.micOn)}
          >
            <TalkIcon name={media.micOn ? 'mic' : 'micOff'} />
            {variant === 'bar' && <span>{media.micOn ? 'Mic on' : 'Muted'}</span>}
          </button>
          <button
            className={`talk-btn ${media.camOn ? 'on' : 'off'}`}
            title={media.camOn ? 'Turn your camera off' : 'Turn your camera on'}
            aria-label={media.camOn ? 'Turn your camera off' : 'Turn your camera on'}
            aria-pressed={media.camOn}
            onClick={() => void media.setCam(!media.camOn).then((ok) => { if (ok && media.camOn) funnel.cameraEnabled(); })}
          >
            <TalkIcon name={media.camOn ? 'cam' : 'camOff'} />
            {variant === 'bar' && <span>{media.camOn ? 'Camera on' : 'Camera off'}</span>}
          </button>
          <button className="talk-btn leave" title="Leave table talk" aria-label="Leave table talk" onClick={media.leave}>
            <TalkIcon name="leave" />
            {variant === 'bar' && <span>Leave</span>}
          </button>
          {media.joined && <span className="talk-dot live" title="Table talk live" />}
        </>
      )}
      {media.error && variant === 'bar' && <span className="talk-error" role="alert">{media.error}</span>}
    </span>
  );
}
