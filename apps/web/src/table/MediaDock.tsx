import { useState } from 'react';

/**
 * The live voice/camera dock, shared by the lobby and the table. This is the
 * layout shell: the WebRTC mesh (server media relay + useMediaChat) powers it
 * in the media release. Controls stay disabled and honest until then.
 */
export default function MediaDock({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  return (
    <div className={`media-dock ${compact ? 'compact' : ''} ${open ? 'open' : ''}`}>
      <button className="media-dock-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <strong>Table talk</strong>
        <small>Voice & faces, peer-to-peer</small>
        {compact && <span className="media-dock-caret">{open ? '▾' : '▸'}</span>}
      </button>
      {open && (
        <>
          <div className="media-dock-controls">
            <button className="media-btn" disabled title="Live voice arrives in the next update">
              🎙️ <span>Mic</span>
            </button>
            <button className="media-btn" disabled title="Live video arrives in the next update">
              📷 <span>Cam</span>
            </button>
          </div>
          <p className="media-dock-note">Coming right up — live voice and webcam land with the next update.</p>
        </>
      )}
    </div>
  );
}
