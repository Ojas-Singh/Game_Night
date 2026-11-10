import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useRoom } from './useRoom.js';
import { useMediaChat } from './useMediaChat.js';
import HomePage from './pages/HomePage.js';
import GamePage from './pages/GamePage.js';
import { PrivacyPage, TosPage } from './pages/LegalPages.js';
import FullscreenButton from './FullscreenButton.js';

// The lab is a working page few visitors open; it loads when asked for.
const LabPage = lazy(() => import('./pages/LabPage.js'));

export default function App() {
  const room = useRoom();
  // One media owner for the whole app: join once, talk in lobby AND table.
  const media = useMediaChat(room.socket, room.myPlayerId, room.roomId);
  return (
    <>
      <Routes>
        <Route path="/" element={<HomePage room={room} />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/tos" element={<TosPage />} />
        <Route path="/lab" element={<Suspense fallback={null}><LabPage /></Suspense>} />
        <Route
          path="/game/:roomId"
          element={
            <RequireRoom room={room}>
              <GamePage room={room} media={media} />
            </RequireRoom>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <FullscreenButton className="fs-global" />
      {room.status === 'reconnecting' && room.roomId && (
        <div className="reconnect-banner" role="status">
          <span className="reconnect-dot" /> Connection lost — reconnecting…
        </div>
      )}
    </>
  );
}

function RequireRoom({ room, children }: { room: ReturnType<typeof useRoom>; children: React.ReactNode }) {
  const { roomId } = useParams<{ roomId: string }>();
  if (!roomId) return <Navigate to="/" replace />;
  return (
    <>
      {children}
      {/* Join is triggered inside GamePage once the socket is up. */}
      {!room.socket && <div className="overlay-msg">Connecting…</div>}
      {room.joinError && (
        <div className="overlay-msg error">
          {room.joinError}
          <a href="/"> ← back home</a>
        </div>
      )}
    </>
  );
}
