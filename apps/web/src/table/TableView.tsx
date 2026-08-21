import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { RoomApi, CardFlight } from '../useRoom.js';
import type { CaboPlayerView } from '@cabo/views.js';
import Card from './Card.js';
import TableCenter from './TableCenter.js';
import SeatPlanner from './SeatPlanner.js';
import ScoreBoard from './ScoreBoard.js';
import CardFlights from './CardFlights.js';
import { useGuidance } from './guidance.js';
import ChatPanel from '../chat/ChatPanel.js';
import SoundToggle from '../SoundToggle.js';
import EmotePicker from '../EmotePicker.js';
import FloatingEmote from './FloatingEmote.js';
import InfoModal from './InfoModal.js';

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

  const [infoOpen, setInfoOpen] = useState(false);

  const myHand = view.handCardIds[me.id] ?? [];
  const isMyTurn = view.players.find((p) => p.isCurrentTurn)?.id === me.id;

  // ----- Card-flights overlay ---------------------------------------------
  const [flights, setFlights] = useState<CardFlight[]>([]);
  const seenFlightIds = useRef<Set<string>>(new Set());
  // Adopt new flights from the room, dropping the ones we've already shown.
  useEffect(() => {
    setFlights((cur) => {
      const existing = new Set(cur.map((f) => f.id));
      const fresh = room.flights.filter((f) => !existing.has(f.id) && !seenFlightIds.current.has(f.id));
      fresh.forEach((f) => seenFlightIds.current.add(f.id));
      return fresh.length ? [...cur, ...fresh] : cur;
    });
  }, [room.flights]);
  const dropFlight = useMemo(
    () => (id: string) => setFlights((cur) => cur.filter((f) => f.id !== id)),
    [],
  );
  // Map playerId → desktop percent coords for the ghost-card source.
  const seatPos = useMemo((): Record<string, { x: number; y: number }> => {
    const map: Record<string, { x: number; y: number }> = {};
    others.forEach((p, i) => {
      const s = seats[i]!;
      map[p.id] = { x: parseFloat(s.style.left as string), y: parseFloat(s.style.top as string) };
    });
    // The local player sits bottom-centre.
    map[me.id] = { x: 50, y: 96 };
    return map;
  }, [others, seats, me.id]);

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
      // 2x2 (column-flow) layout: the BOTTOM ROW is indexes 1 and 3 — the two
      // cards closest to the player. Only those are offered for the initial
      // peek; the top row (0,2) stays locked.
      const idx = myHand.indexOf(cardId);
      const isBottom = idx === 1 || idx === 3;
      if (!isBottom) {
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
      // Flush mode: you may attempt to discard ANY card you think matches the
      // pile (even a blind guess). If it doesn't match, the server charges the
      // misflush penalty. Rapid single-tap flush.
      act({ type: 'FLUSH_OWN', cardIds: [cardId] });
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
      {/* Test Mode — reveals every card so you can verify the flow. */}
      {room.testMode && <div className="test-banner">TEST MODE — all cards revealed</div>}
      {room.lobby?.hostId === room.myPlayerId && (
        <button
          className={`test-toggle ${room.testMode ? 'on' : ''}`}
          onClick={() => room.setTestMode(!room.testMode)}
          title={room.testMode ? 'Turn off Test Mode' : 'Turn on Test Mode (see every card)'}
          aria-label="Toggle Test Mode"
        >
          {room.testMode ? 'TEST ON' : 'TEST'}
        </button>
      )}
      <SoundToggle />
      <EmotePicker room={room} />
      <button
        className="info-toggle"
        onClick={() => setInfoOpen(true)}
        aria-label="Rules"
        title="How to play"
      >
        ❓
      </button>

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
                  // A card is shown face-up only if we actually KNOW its value
                  // (during the reveal window, or round reveal). Unknown cards
                  // always stay face-down. In Test Mode the server reveals
                  // everything, so all cards render face-up for testing.
                  const revealed =
                    room.testMode || (!!known && (flashActive(cardId) || mode === 'round-over'));
                  return (
                    <Card
                      key={cardId}
                      cardId={cardId}
                      card={known ?? null}
                      faceDown={!revealed}
                      seenMarker={!!known && !revealed}
                      contentRotate={-seat.facing}
                      small
                      test={room.testMode}
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

        {/* flying-card overlay: every player sees where each card went */}
        <CardFlights
          flights={flights}
          seatPos={seatPos}
          discardPos={{ x: 50, y: 46 }}
          drawPos={{ x: 88, y: 78 }}
          onDone={dropFlight}
        />

        {/* my hand */}
        <div className={`seat seat-me ${isMyTurn ? 'active' : ''}`}>
          <FloatingEmote emote={room.emotes[me.id]} />
          <div className="my-hand hand-grid">
            <AnimatePresence>
              {myHand.map((cardId, idx) => {
                const known = view.knownCards[cardId];
                // Only cards you actually know render face-up — on your own
                // turn, during the brief reveal window, or at round reveal.
                // Cards you've never seen stay face-down (no "all open").
                // In Test Mode the server reveals everything, so all cards
                // render face-up (with a see-through test tint) for testing.
                const revealed =
                  room.testMode ||
                  (!!known && (isMyTurn || flashActive(cardId) || mode === 'round-over'));
                const highlight =
                  (mode === 'initial-peek' && flushSel.includes(cardId)) ||
                  (mode === 'power-blind-swap' && selectedOwn === cardId) ||
                  (canFlushNow && known?.rank === view.discardTopRank);
                // During the initial peek only the bottom row is reachable.
                const isBottomIdx = idx === 1 || idx === 3;
                const dimmed = mode === 'initial-peek' && !isBottomIdx;
                return (
                  <Card
                    key={cardId}
                    cardId={cardId}
                    card={known ?? null}
                    faceDown={!revealed}
                    seenMarker={!!known && !revealed}
                    highlight={!!highlight}
                    dimmed={dimmed}
                    test={room.testMode}
                    lifted={mode === 'draw-decision' || mode === 'initial-peek' || mode === 'power-peek-own' || mode === 'transfer'}
                    onClick={() => onMyCardClick(cardId)}
                  />
                );
              })}
            </AnimatePresence>
          </div>
          {view.drawnCard && (
            <div className="draw-slot">
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
              <span className="draw-slot-label">drawn</span>
              {mode === 'draw-decision' && (
                <>
                  <span className="draw-slot-hint">
                    keep: tap a hand card · discard: tap the drawn card
                  </span>
                  <button
                    className="draw-discard-btn"
                    onClick={() => act({ type: 'DISCARD_DRAWN' })}
                  >
                    Discard drawn card
                  </button>
                </>
              )}
            </div>
          )}
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

      <InfoModal open={infoOpen} onClose={() => setInfoOpen(false)} />

      <ChatPanel room={room} floating />
    </div>
  );
}
