import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { RoomApi } from '../useRoom.js';
import { loadName } from '../session.js';
import { labApi } from '../lab/api.js';

export default function SharedGamePage({ room }: { room: RoomApi }) {
  const { shareId } = useParams();
  const navigate = useNavigate();
  const [game, setGame] = useState<{ title: string; specHash: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { labApi(`/shared/${shareId}`).then(setGame).catch(e => setError(e.message)); }, [shareId]);
  async function launch(ai: boolean) {
    setBusy(true); setError('');
    try {
      const { token } = await labApi(`/shared/${shareId}/room`, {});
      const result = await room.createRoom(loadName() || 'Host', token, ai);
      if (!result.ok) throw new Error(result.error);
      navigate(`/game/${result.roomId}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <main className="scroll-page"><section className="lab-create shared-game"><Link to="/gamelab">← Game Lab</Link>
    <p className="eyebrow">YOU'RE INVITED</p><h1>{game?.title || 'A new game awaits'}</h1><p>Start a table with these exact rules.</p>
    {error && <p role="alert">{error}</p>}
    <div className="launch-row"><button disabled={!game || busy || !room.socket} onClick={() => void launch(false)}>Play with friends</button>
    <button disabled={!game || busy || !room.socket} onClick={() => void launch(true)}>Play vs AI</button></div>
  </section></main>;
}
