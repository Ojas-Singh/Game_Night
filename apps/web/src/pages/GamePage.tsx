import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { RoomApi } from '../useRoom.js';
import type { MediaChat } from '../useMediaChat.js';
import LobbyView from '../lobby/LobbyView.js';
import TableView from '../table/TableView.js';
import PairOneTable from '../pairone/PairOneTable.js';
import RuleZeroTable from '../rulezero/RuleZeroTable.js';
import SeepTable from '../seep/SeepTable.js';
import TableShell from '../table/TableShell.js';
import ActionBar from '../table/ActionBar.js';

export default function GamePage({ room, media }: { room: RoomApi; media: MediaChat }) {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const joinedRef = useRef(false);
  const [namePrompt, setNamePrompt] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState('');

  useEffect(() => {
    if (!room.socket || !roomId || joinedRef.current) return;
    joinedRef.current = true;
    void room.joinRoom(roomId).then((res) => {
      if (!res.ok && res.error === 'game already in progress') {
        setNamePrompt(roomId);
      } else if (!res.ok && /full|not found|closed/i.test(res.error ?? '')) {
        navigate('/', { replace: true });
      }
    });
  }, [room, roomId, navigate]);

  if (namePrompt) {
    return (
      <div className="overlay-msg">
        <div className="home-card compact">
          <h2 className="font-display">Game in progress</h2>
          <p className="home-sub">The game is underway. Watch the public table while your friends play.</p>
          <button onClick={() => void room.joinRoom(roomId!, undefined, true).then(r => { if (r.ok) setNamePrompt(null); })}>Watch table</button>
          <button className="ghost" onClick={() => navigate('/')}>
            Back home
          </button>
        </div>
      </div>
    );
  }

  if (room.joinError) {
    return (
      <div className="overlay-msg error">
        <div className="home-card compact">
          <h2 className="font-display">Room unavailable</h2>
          <p className="home-sub">{room.joinError}</p>
          <button className="ghost" onClick={() => navigate('/')}>
            Back home
          </button>
        </div>
      </div>
    );
  }

  if (!room.lobby) {
    return <div className="overlay-msg">Joining table…</div>;
  }

  // Route to the right table by the view's game discriminator.
  const view = room.view;
  if (room.lobby.inGame && view) {
    if (view.gameId === 'pairone') {
      return <PairOneTable room={room} view={view} />;
    }
    if (view.gameId === 'seep') {
      return <SeepTable room={room} view={view} />;
    }
    if (view.gameId === 'rulezero') {
      return (
        <TableShell room={room} title="Game Night · Custom table" actor={view.rz.currentActor}>
        <RuleZeroTable
          view={view.rz}
          review={view.review}
          onAction={(envActionId) =>
            room.sendAction({
              type: 'RZ_APPLY',
              actionIndex: envActionId,
            } as never)
          }
        />
        {view.rz.isTerminal && room.lobby.hostId === room.myPlayerId && <ActionBar actions={[{ id: "again", label: "Play again", run: room.playAgain }]} />}
        </TableShell>
      );
    }
    return <TableView room={room} view={view} media={media} />;
  }
  return <LobbyView room={room} media={media} />;
}
