import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { RoomApi, CardFlight } from '../useRoom.js';
import type { FlightPos } from './CardFlights.js';
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
import Avatar from './Avatar.js';

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
  const flashActive = (cardId: string): boolean => {
    const f = room.peekFlash[cardId];
    return !!f && Date.now() - f.at < f.ms;
  };

  // Seat geometry: 2..6 opponents distribute around the top arc.
  const seats = useMemo(() => SeatPlanner(others.length), [others.length]);

  const [infoOpen, setInfoOpen] = useState(false);

  // ---- Pixel-accurate flight anchors -----------------------------------
  // Every flight source/destination is MEASURED from the real DOM (deck pile,
  // discard pile, draw slot, each player's actual hand grid) instead of being
  // guessed from planner percentages — so ghosts fly along true paths.
  const tableRef = useRef<HTMLDivElement>(null);
  const [anchors, setAnchors] = useState<{
    size: { w: number; h: number };
    deck: FlightPos;
    discard: FlightPos;
    draw: FlightPos;
    hands: Record<string, FlightPos>;
    cards: Record<string, FlightPos>;
  } | null>(null);
  const measureAnchors = useCallback(() => {
    const table = tableRef.current;
    if (!table) return;
    const rect = table.getBoundingClientRect();
    const center = (el: Element | null): FlightPos | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - rect.left + r.width / 2, y: r.top - rect.top + r.height / 2 };
    };
    const hands: Record<string, FlightPos> = {};
    table.querySelectorAll<HTMLElement>('[data-hand-for]').forEach((el) => {
      const pid = el.dataset.handFor;
      const pos = center(el);
      if (pid && pos) hands[pid] = pos;
    });
    // Per-card anchors: trajectories land in the CENTRE of the exact card.
    const cards: Record<string, FlightPos> = {};
    table.querySelectorAll<HTMLElement>('[data-card-id]').forEach((el) => {
      const cid = el.dataset.cardId;
      const pos = center(el);
      if (cid && pos) cards[cid] = pos;
    });
    setAnchors({
      size: { w: rect.width, h: rect.height },
      // Pile faces (not the labelled container, whose text shifts the centre).
      deck: center(table.querySelector('.deck-pile .deck-stack.s3')) ?? center(table.querySelector('.deck-pile')) ?? { x: rect.width * 0.46, y: rect.height * 0.46 },
      discard: center(table.querySelector('.discard-pile .discard-card')) ??
        center(table.querySelector('.discard-pile .discard-empty')) ??
        center(table.querySelector('.discard-pile')) ?? { x: rect.width * 0.54, y: rect.height * 0.46 },
      // The drawn card element itself when present, else the slot.
      draw: center(table.querySelector('.draw-slot .pcard')) ?? center(table.querySelector('.draw-slot')) ?? { x: rect.width * 0.62, y: rect.height * 0.5 },
      hands,
      cards,
    });
  }, []);
  useLayoutEffect(() => {
    measureAnchors();
    window.addEventListener('resize', measureAnchors);
    return () => window.removeEventListener('resize', measureAnchors);
  }, [measureAnchors, room.flights, others.length]);

  const myHand = view.handCardIds[me.id] ?? [];
  const isMyTurn = view.players.find((p) => p.isCurrentTurn)?.id === me.id;
  // Avatar looks come from the lobby roster (customizable, skribbl-style).
  const fallbackAvatar = { color: 0, eyes: 0, mouth: 0, hat: 0 };
  const avatarOf = (pid: string) =>
    room.lobby?.players.find((p) => p.id === pid)?.avatar ?? fallbackAvatar;
  // A flushed card leaves an empty slot so positions never shuffle.
  const isEmptySlot = (cardId: string) => cardId.startsWith('__slot__');
  // Which player recently peeked at a card (eye badge) — everyone sees it.
  const peekedBy = (cardId: string): string | null => {
    const m = room.peekMarks[cardId];
    if (!m) return null;
    return view.players.find((p) => p.id === m.byPlayerId)?.name ?? null;
  };
  const myLiveCount = myHand.filter((id) => !isEmptySlot(id)).length;

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
  // Interaction state for powers / decisions.
  const [selectedOwn, setSelectedOwn] = useState<string | null>(null);
  const [targetPlayer, setTargetPlayer] = useState<string | null>(null);
  const guidance = useGuidance(view, room.myPlayerId ?? me.id);

  const act = (action: Parameters<RoomApi['sendAction']>[0]) => {
    void room.sendAction(action).then((res) => {
      if (!res.ok && res.error) guidance.setError(res.error);
    });
    setSelectedOwn(null);
    setTargetPlayer(null);
  };

  // ---------------------------------------------------------------------
  // Action modes
  // ---------------------------------------------------------------------

  const phase = view.phase;
  const pendingPower = view.pendingPower?.power ?? null;

  const mode:
    | 'draw-decision'
    | 'power-peek-own'
    | 'power-peek-other'
    | 'power-blind-swap'
    | 'power-swap-others'
    | 'transfer'
    | 'flush-other'
    | 'idle'
    | 'round-over' = useMemo(() => {
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
  }, [phase, pendingPower, isMyTurn, view.pendingTransfer]);

  // Flush: clicking own cards while not mid-decision, when rank matches discard.
  const canFlushNow =
    (mode === 'idle' || mode === 'draw-decision') &&
    view.discardTopRank !== null &&
    phase !== 'ROUND_COMPLETE';

  const onMyCardClick = (cardId: string) => {
    if (isEmptySlot(cardId)) return;
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
      {/* The starting peek: a sticky reminder while your cards are flashed. */}
      {myHand.some((id) => {
        const f = room.peekFlash[id];
        return f && f.ms >= 6000 && Date.now() - f.at < f.ms;
      }) && <div className="memorize-note">👁 Remember your bottom two cards!</div>}
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
      <div className="table-ellipse" ref={tableRef}>
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
              <div className="seat-avatar">
                <Avatar avatar={avatarOf(p.id)} size={46} crown={isTurn} ring={isTurn} />
              </div>
              <div
                className="seat-cards hand-grid"
                data-hand-for={p.id}
                style={seat.facing ? { transform: `rotate(${seat.facing}deg)` } : undefined}
              >
                {(view.handCardIds[p.id] ?? []).map((cardId) =>
                  isEmptySlot(cardId) ? (
                    <div key={cardId} className="card-slot-empty small" />
                  ) : (
                    (() => {
                      const known = view.knownCards[cardId];
                      // Memory game: a card renders face-up ONLY while it is
                      // being revealed (peek flash / round reveal) or in Test
                      // Mode. Knowing a value never keeps it face-up — the
                      // "seen" dot is the only reminder.
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
                          peekedBy={peekedBy(cardId)}
                          selectable={selectable}
                          onClick={() => onOpponentCardClick(p.id, cardId)}
                        />
                      );
                    })()
                  ),
                )}
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
        {anchors && (
          <CardFlights
            flights={flights}
            anchors={anchors}
            myId={me.id}
            onDone={dropFlight}
          />
        )}

        {/* my hand */}
        <div className={`seat seat-me ${isMyTurn ? 'active' : ''}`}>
          <FloatingEmote emote={room.emotes[me.id]} />
          <div className="seat-avatar">
            <Avatar avatar={avatarOf(me.id)} size={46} crown={isMyTurn} ring={isMyTurn} />
          </div>
          <div className="my-hand hand-grid" data-hand-for={me.id}>
            <AnimatePresence>
              {myHand.map((cardId) =>
                isEmptySlot(cardId) ? (
                  <div key={cardId} className="card-slot-empty" />
                ) : (
                  (() => {
                    const known = view.knownCards[cardId];
                    // Memory game: your own cards render face-up ONLY during
                    // a reveal window (peek flash / round reveal) or Test
                    // Mode — never just because it's your turn or you once
                    // saw the value. The "seen" dot is the only reminder.
                    const revealed =
                      room.testMode || (!!known && (flashActive(cardId) || mode === 'round-over'));
                    const highlight = mode === 'power-blind-swap' && selectedOwn === cardId;
                    return (
                      <Card
                        key={cardId}
                        cardId={cardId}
                        card={known ?? null}
                        faceDown={!revealed}
                        seenMarker={!!known && !revealed}
                        highlight={!!highlight}
                        test={room.testMode}
                        peekedBy={peekedBy(cardId)}
                        lifted={mode === 'draw-decision' || mode === 'power-peek-own' || mode === 'transfer'}
                        onClick={() => onMyCardClick(cardId)}
                      />
                    );
                  })()
                ),
              )}
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
          <div className="seat-label me-label">
            <span className="seat-name">{me.name} (you)</span>
            <span className="seat-count">{myLiveCount}</span>
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
