/**
 * An avatar slot that becomes a live camera circle when that player's camera
 * is on. Works for remote seats (their WebRTC stream from the mesh) and for
 * my own seat (my outbound stream). Falls back to the classic Avatar
 * whenever there is no live video.
 */

import { useEffect, useRef } from 'react';
import type { MediaChat } from '../useMediaChat.js';
import type { Avatar as AvatarSpec } from '../server-protocol.js';
import Avatar from './Avatar.js';

interface AvatarCamProps {
  media: MediaChat;
  playerId: string;
  /** When playerId matches, the slot shows MY outbound camera. */
  myPlayerId?: string | null;
  avatar: AvatarSpec;
  size?: number;
  crown?: boolean;
  ring?: boolean;
  cabo?: boolean;
  /** Also render the peer's audio element (for host-less inline layouts). */
  audio?: boolean;
}

export default function AvatarCam({ media, playerId, myPlayerId, avatar, size = 42, crown, ring, cabo, audio = false }: AvatarCamProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const isSelf = myPlayerId != null && playerId === myPlayerId;
  const peer = media.peers.find((p) => p.playerId === playerId);
  // Video comes from the video-only stream; the peer's `stream` carries audio
  // and must never be used as a picture source.
  const stream = isSelf ? media.localStream : peer?.videoStream ?? null;
  const camOn = isSelf ? media.camOn : Boolean(peer?.cam);
  const live = Boolean(stream && camOn);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (stream && el.srcObject !== stream) {
      el.srcObject = stream;
      void el.play().catch(() => /* autoplay guard */ undefined);
    }
    if (!stream && el.srcObject) {
      el.srcObject = null;
    }
  }, [stream, live]);

  // Audio sink for this player when the surrounding layout has no dedicated one.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const audioStream = peer?.stream ?? null;
    if (!isSelf && audioStream && el.srcObject !== audioStream) {
      el.srcObject = audioStream;
      void el.play().catch(() => /* autoplay guard */ undefined);
    }
    if ((isSelf || !audioStream) && el.srcObject) el.srcObject = null;
  }, [peer?.stream, isSelf]);

  // Voice state: a mic badge for everyone in table talk (green on, red
  // crossed out when muted) and pulsing rings while they are talking.
  const inVoice = isSelf ? media.joined : Boolean(peer);
  const micOn = isSelf ? media.micOn : Boolean(peer?.mic);
  const speaking = inVoice && micOn && media.speaking.has(playerId);
  const badge = Math.max(14, Math.round(size * 0.38));

  const face = live ? (
    <span
      className={`avatar-cam ${crown ? 'is-turn' : ''}`}
      style={{ width: size, height: size }}
      data-cam="on"
    >
      <video ref={videoRef} autoPlay playsInline muted />
    </span>
  ) : (
    <Avatar avatar={avatar} size={size} crown={crown} ring={ring} cabo={cabo} />
  );

  const cam = (
    <span
      className={`voice-wrap ${speaking ? 'speaking' : ''}`}
      style={{ width: size, height: size }}
      title={inVoice ? (speaking ? 'Talking' : micOn ? 'Mic on' : 'Muted') : undefined}
    >
      {face}
      {speaking && (
        <span className="voice-rings" aria-hidden>
          <span />
          <span />
        </span>
      )}
      {inVoice && (
        <span className={`voice-mic ${micOn ? 'on' : 'off'}`} style={{ width: badge, height: badge }} aria-label={micOn ? 'mic on' : 'muted'}>
          <svg viewBox="0 0 24 24" width={badge * 0.66} height={badge * 0.66} aria-hidden fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" stroke="none" />
            <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
            {!micOn && <path d="M4 4l16 16" />}
          </svg>
        </span>
      )}
    </span>
  );

  if (!audio || isSelf) return cam;
  return (
    <>
      {cam}
      <audio ref={audioRef} autoPlay playsInline />
    </>
  );
}
