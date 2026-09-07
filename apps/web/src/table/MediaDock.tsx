import { useEffect, useState } from 'react';
import type { MediaChat, MediaPeer } from '../useMediaChat.js';
import type { LobbyPlayer } from '../server-protocol.js';
import { funnel } from '../analytics.js';
import Avatar from './Avatar.js';

interface MediaDockProps {
  media: MediaChat;
  players: LobbyPlayer[];
  myPlayerId: string | null;
  compact?: boolean;
}

function attachStream(el: HTMLMediaElement | null, stream: MediaStream | null): void {
  if (el && stream && el.srcObject !== stream) el.srcObject = stream;
}

/** One remote participant: live video tile (or muted avatar) + mic state. */
function PeerTile({ peer, player }: { peer: MediaPeer; player?: LobbyPlayer }) {
  const name = player?.name ?? 'Player';
  return (
    <div className={`media-peer ${peer.speaking ? 'speaking' : ''} ${peer.connection}`} title={`${name} · ${peer.connection}`}>
      {peer.cam && peer.stream ? (
        <video ref={(el) => attachStream(el, peer.stream)} autoPlay playsInline className="media-peer-video" />
      ) : (
        <span className="media-peer-avatar">
          <Avatar avatar={player?.avatar ?? { color: 0, eyes: 0, mouth: 0, hat: 0 }} size={34} />
        </span>
      )}
      <audio ref={(el) => attachStream(el, peer.stream)} autoPlay />
      <span className="media-peer-name">{name}</span>
      {!peer.mic && <span className="media-peer-mic-off" title="Microphone off">🔇</span>}
      {peer.connection === 'failed' && <span className="media-peer-failed" title="Direct connection failed (NAT)">⚠ direct link failed</span>}
    </div>
  );
}

/**
 * Live voice + webcam dock, shared by the lobby and the table. Joining
 * requests mic (and optionally camera); media flows peer-to-peer — the server
 * only relays connection setup, never audio or video.
 */
export default function MediaDock({ media, players, myPlayerId, compact = false }: MediaDockProps) {
  const [open, setOpen] = useState(!compact);
  const joined = media.joined;
  const me = players.find((p) => p.isYou);

  // Fold the dock when the user leaves the call (compact placement only).
  useEffect(() => {
    if (compact && !joined) setOpen(false);
  }, [compact, joined]);

  if (!media.supported) return null;

  return (
    <div className={`media-dock ${compact ? 'compact' : ''} ${open ? 'open' : ''} ${joined ? 'live' : ''}`}>
      <button className="media-dock-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <strong>Table talk {joined && <span className="media-live-dot" aria-label="Live" />}</strong>
        {!compact && <small>{joined ? 'Live · peer-to-peer' : 'Voice & faces, peer-to-peer'}</small>}
        {compact && <span className="media-dock-caret">{open ? '▾' : '▸'}</span>}
      </button>
      {open && !joined && (
        <div className="media-dock-body">
          <div className="media-dock-controls">
            <button
              className="media-btn join"
              onClick={() => void media.join({ mic: true, cam: false }).then((ok) => { if (ok) funnel.voiceJoined(); })}
            >
              🎙️ <span>Voice</span>
            </button>
            <button
              className="media-btn join"
              onClick={() => void media.join({ mic: true, cam: true }).then((ok) => { if (ok) { funnel.voiceJoined(); funnel.cameraEnabled(); } })}
            >
              📷 <span>Voice + video</span>
            </button>
          </div>
          {media.error && <p className="media-dock-error" role="alert">{media.error}</p>}
          <p className="media-dock-note">Peer-to-peer: the server never records or relays your stream.</p>
        </div>
      )}
      {open && joined && (
        <div className="media-dock-body">
          <div className="media-dock-controls">
            <button className={`media-btn ${media.micOn ? 'on' : 'off'}`} onClick={() => media.setMic(!media.micOn)} aria-pressed={media.micOn}>
              {media.micOn ? '🎙️' : '🔇'} <span>{media.micOn ? 'Mic on' : 'Muted'}</span>
            </button>
            <button className={`media-btn ${media.camOn ? 'on' : 'off'}`} onClick={() => void media.setCam(!media.camOn).then((ok) => { if (ok && media.camOn) funnel.cameraEnabled(); })} aria-pressed={media.camOn}>
              📷 <span>{media.camOn ? 'Cam on' : 'Cam off'}</span>
            </button>
            <button className="media-btn leave" onClick={media.leave} title="Leave the call">
              ⏏ <span>Leave</span>
            </button>
          </div>
          {media.error && <p className="media-dock-error" role="alert">{media.error}</p>}
          <div className="media-peers">
            {me && (
              <div className={`media-peer self ${media.micOn ? '' : 'muted'}`} title="You">
                <span className="media-peer-avatar">
                  <Avatar avatar={me.avatar} size={34} />
                </span>
                <span className="media-peer-name">{me.name} (you)</span>
                {!media.micOn && <span className="media-peer-mic-off">🔇</span>}
              </div>
            )}
            {media.peers.map((peer) => (
              <PeerTile key={peer.playerId} peer={peer} player={players.find((p) => p.id === peer.playerId)} />
            ))}
            {media.peers.length === 0 && <p className="media-dock-note">Waiting for others to join the call…</p>}
          </div>
        </div>
      )}
      {!open && joined && <span className="media-live-dot" aria-label="Call live" />}
      {!open && !joined && myPlayerId && <span className="media-dock-hint">🎙️</span>}
    </div>
  );
}
