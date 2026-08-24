import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useRoom } from './useRoom.js';
import HomePage from './pages/HomePage.js';
import GamePage from './pages/GamePage.js';
import RuleZeroDemo from './rulezero/RuleZeroDemo.js';

export default function App() {
  const room = useRoom();
  return (
    <>
      <Routes>
        <Route path="/" element={<HomePage room={room} />} />
        <Route path="/rulezero-demo" element={<RuleZeroDemo />} />
        <Route
          path="/game/:roomId"
          element={
            <RequireRoom room={room}>
              <GamePage room={room} />
            </RequireRoom>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
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
          <a href="#/"> ← back home</a>
        </div>
      )}
    </>
  );
}
