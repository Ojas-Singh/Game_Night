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
}

export default function AvatarCam({ media, playerId, myPlayerId, avatar, size = 42, crown, ring, cabo }: AvatarCamProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const isSelf = myPlayerId != null && playerId === myPlayerId;
  const peer = media.peers.find((p) => p.playerId === playerId);
  const stream = isSelf ? media.localStream : peer?.stream ?? null;
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
  }, [stream]);

  if (!live) {
    return <Avatar avatar={avatar} size={size} crown={crown} ring={ring} cabo={cabo} />;
  }

  return (
    <span
      className={`avatar-cam ${crown ? 'is-turn' : ''}`}
      style={{ width: size, height: size }}
      data-cam="on"
    >
      <video ref={videoRef} autoPlay playsInline muted />
    </span>
  );
}
