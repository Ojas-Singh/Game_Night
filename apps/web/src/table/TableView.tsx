import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { RoomApi } from '../useRoom.js';
import type { CaboPlayerView } from '@cabo/views.js';
import Card from './Card.js';
import TableCenter from './TableCenter.js';
import SeatPlanner from './SeatPlanner.js';
import ScoreBoard from './ScoreBoard.js';
import { useGuidance } from './guidance.js';
import ChatPanel from '../chat/ChatPanel.js';
import SoundToggle from '../SoundToggle.js';
import EmotePicker from '../EmotePicker.js';
import FloatingEmote from './FloatingEmote.js';

/**
 * The round-table experience. The local player always sits at the bottom;
 * opponents are distributed around the ellipse by SeatPlanner. All card
 * positions derive from the seat angle so animations read as physical
 * movement around the table.
 */
export default function TableView({ room }: { room: RoomApi }) {
  const view = room.view!;
  const me = view.players.find((p) => p.id === room.myPlayerId) ?? view.players[0]!;
  const others = view.players.filter((p) => p.id !== me.id);
  // Cards inside their brief reveal window render face-up; afterwards they
  // flip back down (knowledge retained as a small "seen" marker).
  const flashActive = (cardId: string): boolean =>
    !!room.peekFlash[cardId] && Date.now() - room.peekFlash[cardId] < 2_600;

  // Seat geometry: 2..6 opponents distribute around the top arc.
  const seats = useMemo(() => SeatPlanner(others.length), [others.length]);

  const myHand = view.handCardIds[me.id] ?? [];
  const isMyTurn = view.players.find((p) => p.isCurrentTurn)?.id === me.id;

  // Interaction state for powers / decisions.
  const [selectedOwn, setSelectedOwn] = useState<string | null>(null);
  const [targetPlayer, setTargetPlayer] = useState<string | null>(null);
  const [flushSel, setFlushSel] = useState<string[]>([]);
  const guidance = useGuidance(view, room.myPlayerId ?? me.id);

  const act = (action: Parameters<RoomApi['sendAction']>[0]) => {
    void room.sendAction(action).then((res) => {
      if (!res.ok && res.error) guidance.setError(res.error);
    });
    setSelectedOwn(null);
    setTargetPlayer(null);
    setFlushSel([]);
  };

  // ---------------------------------------------------------------------
  // Action modes
  // ---------------------------------------------------------------------

  const phase = view.phase;
  const pendingPower = view.pendingPower?.power ?? null;
  const needsPeek = view.needsInitialPeek;

  const mode:
    | 'initial-peek'
    | 'draw-decision'
    | 'power-peek-own'
    | 'power-peek-other'
    | 'power-blind-swap'
    | 'power-swap-others'
    | 'transfer'
    | 'flush-other'
    | 'idle'
    | 'round-over' = useMemo(() => {
    if (phase === 'INITIAL_PEEK' && needsPeek) return 'initial-peek';
    if (phase === 'ROUND_COMPLETE') return 'round-over';
    if (phase === 'TRANSFER_PENDING' && view.pendingTransfer) return 'transfer';
    if (phase === 'DRAW_DECISION' && isMyTurn) return 'draw-decision';
    if (pendingPower) {
      return {
        PEEK_OWN: 'power-peek-own',
        PEEK_OTHER: 'power-peek-other',
        BLIND_SWAP: 'power-blind-swap',
        SWAP_OTHERS: 'power-swap-others',
      }[pendingPower] as typeof mode;
    }
    return 'idle';
  }, [phase, needsPeek, pendingPower, isMyTurn, view.pendingTransfer]);

  // Flush: clicking own cards while not mid-decision, when rank matches discard.
  const canFlushNow =
    (mode === 'idle' || mode === 'draw-decision') &&
    view.discardTopRank !== null &&
    phase !== 'INITIAL_PEEK' &&
    phase !== 'ROUND_COMPLETE';

  const onMyCardClick = (cardId: string) => {
    if (mode === 'initial-peek') {
      // 2x2 layout: only the BOTTOM row (indexes 2,3) is offered at the start.
      const idx = myHand.indexOf(cardId);
      if (idx < 2) {
        guidance.setError('At the start you may only look at your bottom two cards');
        return;
      }
      if (flushSel.includes(cardId)) {
        setFlushSel(flushSel.filter((c) => c !== cardId));
      } else if (flushSel.length < 2) {
        setFlushSel([...flushSel, cardId]);
      }
      return;
    }
    if (mode === 'power-peek-own') {
      act({ type: 'POWER_APPLY', payload: { power: 'PEEK_OWN', cardId } });
      return;
    }
    if (mode === 'power-blind-swap') {
      if (!selectedOwn) {
        setSelectedOwn(cardId);
      } else if (targetPlayer) {
        act({
          type: 'POWER_APPLY',
          payload: { power: 'BLIND_SWAP', ownCardId: selectedOwn, targetPlayerId: targetPlayer, targetCardId: cardId },
        });
      }
      return;
    }
    if (mode === 'draw-decision' && view.drawnCard) {
      act({ type: 'KEEP_DRAWN', handIndex: myHand.indexOf(cardId) });
      return;
    }
    if (canFlushNow) {
      // Flush mode: toggle selection of matching own cards.
      const known = view.knownCards[cardId];
      if (known && known.rank === view.discardTopRank) {
        const next = flushSel.includes(cardId)
          ? flushSel.filter((c) => c !== cardId)
          : [...flushSel, cardId];
        setFlushSel(next);
        // Single-tap rapid flush: fire immediately on selection.
        act({ type: 'FLUSH_OWN', cardIds: next });
      } else if (known) {
        guidance.setError(`That's a ${known.rank} — the pile wants ${view.discardTopRank}`);
      } else {
        guidance.setError('You can only flush cards you know match the pile');
      }
      return;
    }
    if (mode === 'transfer') {
      act({ type: 'TRANSFER_CARD', cardId });
    }
  };

  const onOpponentCardClick = (playerId: string, cardId: string) => {
    if (mode === 'power-peek-other') {
      act({ type: 'POWER_APPLY', payload: { power: 'PEEK_OTHER', targetPlayerId: playerId, cardId } });
    } else if (mode === 'power-blind-swap' && selectedOwn) {
      act({
        type: 'POWER_APPLY',
        payload: { power: 'BLIND_SWAP', ownCardId: selectedOwn, targetPlayerId: playerId, targetCardId: cardId },
      });
    } else if (mode === 'power-swap-others') {
      if (!selectedOwn) {
        setSelectedOwn(cardId);
      } else {
        act({ type: 'POWER_APPLY', payload: { power: 'SWAP_OTHERS', cardIdA: selectedOwn, cardIdB: cardId } });
      }
    } else if (mode === 'idle' && view.discardTopRank !== null) {
      // Flush another player's known card.
      const known = view.knownCards[cardId];
      if (known && known.rank === view.discardTopRank) {
        act({ type: 'FLUSH_OTHER', targetPlayerId: playerId, cardId });
      } else if (known) {
        guidance.setError(`That's a ${known.rank} — doesn't match ${view.discardTopRank}`);
      } else {
        guidance.setError('You can only flush cards you have seen');
      }
    }
  };

  const onOpponentClick = (playerId: string) => {
    if (mode === 'power-peek-other' || mode === 'power-blind-swap') {
      setTargetPlayer(playerId);
    }
  };

  // Which opponent cards are highlighted/selectable.
  const opponentCardsSelectable = (playerId: string): boolean => {
    if (mode === 'power-peek-other') return targetPlayer === playerId;
    if (mode === 'power-blind-swap') return !!selectedOwn && (targetPlayer === playerId || targetPlayer === null);
    if (mode === 'power-swap-others') return true;
    if (mode === 'idle' && view.discardTopRank !== null) {
      return (view.handCardIds[playerId] ?? []).some((id) => {
        const k = view.knownCards[id];
        return k && k.rank === view.discardTopRank;
      });
    }
    return false;
  };

  return (
    <div className="table-room">
      {/* status banner */}
      <div className={`status-banner ${guidance.urgent ? 'urgent' : ''}`}>
        {guidance.text}
      </div>
      <SoundToggle />
      <EmotePicker room={room} />

      {/* the table */}
      <div className="table-ellipse">
        <div className="table-felt" />

        {/* opponents around the arc */}
        {others.map((p, i) => {
          const seat = seats[i]!;
          const isTurn = view.players.find((x) => x.isCurrentTurn)?.id === p.id;
          const selectable = opponentCardsSelectable(p.id);
          const glowing = (mode === 'power-peek-other' || mode === 'power-blind-swap') && !targetPlayer;
          return (
            <div
              key={p.id}
              className={`seat seat-opponent ${isTurn ? 'active' : ''} ${glowing ? 'glow' : ''}`}
              style={seat.style}
            >
              <FloatingEmote emote={room.emotes[p.id]} />
              <div
                className="seat-cards hand-grid"
                style={seat.facing ? { transform: `rotate(${seat.facing}deg)` } : undefined}
              >
                {(view.handCardIds[p.id] ?? []).map((cardId) => {
                  const known = view.knownCards[cardId];
                  const revealed = flashActive(cardId) || mode === 'round-over';
                  return (
                    <Card
                      key={cardId}
                      cardId={cardId}
                      card={known ?? null}
                      faceDown={!revealed}
                      seenMarker={!!known && !revealed}
                      contentRotate={-seat.facing}
                      small
                      selectable={selectable}
                      onClick={() => onOpponentCardClick(p.id, cardId)}
                    />
                  );
                })}
              </div>
              <button className="seat-label" onClick={() => onOpponentClick(p.id)}>
                <span className="seat-name">{p.name}</span>
                <span className="seat-count">{p.cardCount}</span>
              </button>
            </div>
          );
        })}

        {/* centre: deck + discard */}
        <TableCenter
          view={view}
          onDraw={isMyTurn && phase === 'TURN_DRAW' ? () => act({ type: 'DRAW' }) : null}
          onCallCabo={
            isMyTurn && phase === 'TURN_DRAW' && !view.cabo
              ? () => act({ type: 'CALL_CABO' })
              : null
          }
        />

        {/* my hand */}
        <div className={`seat seat-me ${isMyTurn ? 'active' : ''}`}>
          <FloatingEmote emote={room.emotes[me.id]} />
          <div className="my-hand hand-grid">
            <AnimatePresence>
              {myHand.map((cardId, idx) => {
                const known = view.knownCards[cardId];
                const revealed = flashActive(cardId) || mode === 'round-over';
                const highlight =
                  (mode === 'initial-peek' && flushSel.includes(cardId)) ||
                  (mode === 'power-blind-swap' && selectedOwn === cardId) ||
                  (canFlushNow && known?.rank === view.discardTopRank);
                // During the initial peek only the bottom row is reachable.
                const dimmed = mode === 'initial-peek' && idx < 2;
                return (
                  <Card
                    key={cardId}
                    cardId={cardId}
                    card={known ?? null}
                    faceDown={!revealed}
                    seenMarker={!!known && !revealed}
                    highlight={!!highlight}
                    dimmed={dimmed}
                    lifted={mode === 'draw-decision' || mode === 'initial-peek' || mode === 'power-peek-own' || mode === 'transfer'}
                    onClick={() => onMyCardClick(cardId)}
                  />
                );
              })}
            </AnimatePresence>
            {view.drawnCard && (
              <Card
                cardId={view.drawnCard.id}
                card={view.drawnCard}
                drawn
                onClick={
                  mode === 'draw-decision'
                    ? () => act({ type: 'DISCARD_DRAWN' })
                    : undefined
                }
              />
            )}
          </div>
          {mode === 'initial-peek' && flushSel.length === 2 && (
            <button className="peek-confirm" onClick={() => act({ type: 'PEEK_STARTING', cardIndexes: flushSel.map((c) => myHand.indexOf(c)) })}>
              Peek these two
            </button>
          )}
          <div className="seat-label me-label">
            <span className="seat-name">{me.name} (you)</span>
            <span className="seat-count">{myHand.length}</span>
          </div>
        </div>
      </div>

      {/* round-over overlay */}
      {mode === 'round-over' && <ScoreBoard view={view} room={room} />}

      <ChatPanel room={room} floating />
    </div>
  );
}
