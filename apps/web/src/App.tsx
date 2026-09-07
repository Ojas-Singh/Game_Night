import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useRoom } from './useRoom.js';
import { useMediaChat } from './useMediaChat.js';
import HomePage from './pages/HomePage.js';
import GamePage from './pages/GamePage.js';
import RuleZeroDemo from './rulezero/RuleZeroDemo.js';
import GameLabPage from './pages/GameLabPage.js';
import SharedGamePage from './pages/SharedGamePage.js';

export default function App() {
  const room = useRoom();
  // One media owner for the whole app: join once, talk in lobby AND table.
  const media = useMediaChat(room.socket, room.myPlayerId, room.roomId);
  return (
    <>
      <Routes>
        <Route path="/" element={<HomePage room={room} />} />
        <Route path="/rulezero-demo" element={<RuleZeroDemo />} />
            <Route path="/shared/:shareId" element={<SharedGamePage room={room} />} />
        <Route path="/gamelab" element={<GameLabPage room={room} />} />
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
