import { useEffect, useState } from 'react';

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const fsDoc = () => document as FsDocument;
const isFull = () => !!(fsDoc().fullscreenElement ?? fsDoc().webkitFullscreenElement);
const canFull = () =>
  typeof document !== 'undefined' && !!(fsDoc().fullscreenEnabled || fsDoc().webkitFullscreenEnabled);

/**
 * Enter / leave full screen for the whole site (the page keeps working and
 * re-lays itself out at the new size). Hidden where the browser cannot do it
 * (iPhone Safari): there, "Add to Home Screen" gives the same full-screen app.
 */
export default function FullscreenButton({ className = '' }: { className?: string }) {
  const [full, setFull] = useState(isFull);
  useEffect(() => {
    const on = () => {
      setFull(isFull());
      // Layouts that measure the window (table anchors, the backdrop) listen
      // for resize; some browsers fire it late after a full-screen switch.
      window.setTimeout(() => window.dispatchEvent(new Event('resize')), 120);
    };
    document.addEventListener('fullscreenchange', on);
    document.addEventListener('webkitfullscreenchange', on);
    return () => {
      document.removeEventListener('fullscreenchange', on);
      document.removeEventListener('webkitfullscreenchange', on);
    };
  }, []);
  if (!canFull()) return null;
  const toggle = async () => {
    try {
      if (isFull()) {
        await (document.exitFullscreen?.() ?? fsDoc().webkitExitFullscreen?.());
      } else {
        const el = document.documentElement as FsElement;
        await (el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.());
      }
    } catch {
      /* user gesture missing or blocked: nothing to do */
    }
  };
  return (
    <button
      className={`fullscreen-btn ${className}`}
      onClick={() => void toggle()}
      aria-label={full ? 'Exit full screen' : 'Full screen'}
      title={full ? 'Exit full screen' : 'Full screen'}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {full ? (
          <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        ) : (
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        )}
      </svg>
    </button>
  );
}
