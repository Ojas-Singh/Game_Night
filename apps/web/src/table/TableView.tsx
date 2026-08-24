import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RoomApi, CardFlight } from '../useRoom.js';
import type { FlightPos } from './CardFlights.js';
import type { CaboPlayerView } from '@cabo/views.js';
import Card from './Card.js';
import TableCenter from './TableCenter.js';
import SeatPlanner from './SeatPlanner.js';
import ScoreBoard from './ScoreBoard.js';
import CardFlights, { SwapGhosts } from './CardFlights.js';
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
export default function TableView({ room, view }: { room: RoomApi; view: CaboPlayerView }) {
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
  /**
   * The swap event arrives with the already-swapped view. Keep the last
   * committed card coordinates so the swap ghosts can still start at the
   * cards' old slots instead of measuring their new slots.
   */
  const previousCardPositions = useRef<Record<string, FlightPos>>({});
  const [anchors, setAnchors] = useState<{
    size: { w: number; h: number };
    // The table container's viewport rect — used to place the avatar/name
    // pills OUTSIDE the felt, offset toward the screen edges.
    ellipse: { left: number; top: number; width: number; height: number } | null;
    deck: FlightPos;
    discard: FlightPos;
    draw: FlightPos;
    hands: Record<string, FlightPos>;
    cards: Record<string, FlightPos>;
  } | null>(null);

  const readCardPositions = useCallback((table: HTMLDivElement, rect: DOMRect): Record<string, FlightPos> => {
    const cards: Record<string, FlightPos> = {};
    table.querySelectorAll<HTMLElement>('[data-card-id]').forEach((el) => {
      const cid = el.dataset.cardId;
      const r = el.getBoundingClientRect();
      if (cid) cards[cid] = { x: r.left - rect.left + r.width / 2, y: r.top - rect.top + r.height / 2 };
    });
    return cards;
  }, []);

  const captureCardPositions = useCallback(() => {
    const table = tableRef.current;
    if (!table) return;
    previousCardPositions.current = readCardPositions(table, table.getBoundingClientRect());
  }, [readCardPositions]);

  // ---- Swap ghosts (peek style) ------------------------------------------
  // On a swap, each card flies to its partner's OLD slot. This effect runs
  // before the position snapshot below, so previousCardPositions still
  // describes the DOM from the view before the swap.
  const handledSwapPairs = useRef<Set<string>>(new Set());
  const [swapGhosts, setSwapGhosts] = useState<Array<{ id: string; from: FlightPos; to: FlightPos }>>([]);
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table || room.swapPairs.length === 0) return;
    const fresh = room.swapPairs.filter((p) => !handledSwapPairs.current.has(p.id));
    if (fresh.length === 0) return;
    fresh.forEach((p) => handledSwapPairs.current.add(p.id));

    const rect = table.getBoundingClientRect();
    const current = readCardPositions(table, rect);
    const old = previousCardPositions.current;
    const centerOf = (cid: string): FlightPos | null => old[cid] ?? current[cid] ?? null;
    const ghosts: Array<{ id: string; from: FlightPos; to: FlightPos }> = [];
    for (const pair of fresh) {
      const a = centerOf(pair.cardA);
      const b = centerOf(pair.cardB);
      if (a && b) {
        ghosts.push({ id: `${pair.id}-a`, from: a, to: b });
        ghosts.push({ id: `${pair.id}-b`, from: b, to: a });
      }
    }
    if (ghosts.length > 0) {
      setSwapGhosts((cur) => [...cur, ...ghosts].slice(-6));
      const t = setTimeout(() => {
        setSwapGhosts((cur) => cur.filter((g) => !ghosts.some((x) => x.id === g.id)));
      }, 2100);
      return () => clearTimeout(t);
    }
  }, [readCardPositions, room.swapPairs]);

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
    const cards = readCardPositions(table, rect);
    setAnchors({
      size: { w: rect.width, h: rect.height },
      ellipse: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
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
  }, [readCardPositions]);
  useLayoutEffect(() => {
    measureAnchors();
    captureCardPositions();
    const onResize = () => {
      measureAnchors();
      captureCardPositions();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [captureCardPositions, measureAnchors, room.flights, others.length]);

  // Keep the snapshot current after every authoritative view, including
  // swaps (which do not create a normal card flight and therefore would not
  // otherwise rerun measureAnchors).
  useLayoutEffect(() => {
    captureCardPositions();
  }, [captureCardPositions, view.revision, room.swapPairs, others.length]);

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
  // Cards that just swapped glow while gliding to their new slots.
  const wasSwapped = (cardId: string): boolean =>
    !!room.swapMarks[cardId] && Date.now() - room.swapMarks[cardId] < 2000;
  const myLiveCount = myHand.filter((id) => !isEmptySlot(id)).length;

  // ----- Card-flights overlay ---------------------------------------------
  const [flights, setFlights] = useState<CardFlight[]>([]);
  const seenFlightIds = useRef<Set<string>>(new Set());
  // Adopt new flights from the room, dropping the ones we've already shown.
  // LAYOUT effect (not passive): ghosts must mount against anchors measured
  // in the SAME commit, otherwise a destination that just appeared (a draw
  // slot, a re-dealt hand) is missed and the flight collapses invisibly.
  useLayoutEffect(() => {
    setFlights((cur) => {
      const existing = new Set(cur.map((f) => f.id));
      const fresh = room.flights.filter((f) => !existing.has(f.id) && !seenFlightIds.current.has(f.id));
      if (fresh.length === 0) return cur;
      fresh.forEach((f) => seenFlightIds.current.add(f.id));
      // Re-measure synchronously with the adopted batch.
      measureAnchors();
      captureCardPositions();
      return [...cur, ...fresh].slice(-10);
    });
  }, [room.flights, measureAnchors, captureCardPositions]);
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
    | 'turn-end'
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
    if (phase === 'TURN_END' && isMyTurn) return 'turn-end';
    if (pendingPower) {
      return {
        PEEK_OWN: 'power-peek-own',
        PEEK_OTHER: 'power-peek-other',
        BLIND_SWAP: 'power-blind-swap',
      }[pendingPower] as typeof mode;
    }
    return 'idle';
  }, [phase, pendingPower, isMyTurn, view.pendingTransfer]);
  // Flushing stays possible while deciding AND at end of action.

  // Flush: clicking own cards while not mid-decision, when rank matches discard.
  const canFlushNow =
    (mode === 'idle' || mode === 'draw-decision' || mode === 'turn-end') &&
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
    } else if ((mode === 'idle' || mode === 'turn-end') && view.discardTopRank !== null) {
      // Blind guess allowed on ANY card — the server checks the match. If
      // you're wrong you simply draw a penalty; nobody ever learns the card
      // (the UI never tells you its rank either — it's a memory game).
      act({ type: 'FLUSH_OTHER', targetPlayerId: playerId, cardId });
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
    // Blind flushes: every card is clickable (you remember it or you don't).
    if ((mode === 'idle' || mode === 'turn-end') && view.discardTopRank !== null) return true;
    return false;
  };

  // Avatar/name pills live OUTSIDE the felt — at the screen edges, away from
  // the deck — each still aligned toward its owner's seat so it reads clearly.
  // Positions are computed from the measured table rectangle + the seat's
  // percentage location (seat.style.left / top carry the "%"x / "%"y).
  const pillStyle = (seat: (typeof seats)[number] | undefined): CSSProperties | undefined => {
    const ell = anchors?.ellipse;
    if (!ell || !seat) return undefined;
    const lx = parseFloat(String(seat.style.left));
    const ty = parseFloat(String(seat.style.top));
    const sx = ell.left + (lx / 100) * ell.width; // seat's screen x
    const sy = ell.top + (ty / 100) * ell.height; // seat's screen y
    switch (seat.whoSide) {
      // Opposite players: their pill sits beyond their cards, up at the top
      // edge of the screen, horizontally aligned with their seat.
      case 'above':
        return { left: sx, top: Math.max(10, ell.top - 66), transform: 'translateX(-50%)' as const };
      // Side players: their pill hugs the near edge at the seat's height.
      case 'left':
        return { right: 18, top: sy, transform: 'translateY(-50%)' as const };
      case 'right':
        return { left: 18, top: sy, transform: 'translateY(-50%)' as const };
      default:
        return undefined;
    }
  };

  return (
    <div className="table-room">
      {/* status banner */}
      <div className={`status-banner ${guidance.urgent ? 'urgent' : ''}`}>
        {guidance.text}
      </div>
      {/* Test Mode — reveals every card so you can verify the flow. */}
      {room.testMode && <div className="test-banner">TEST MODE — all cards revealed</div>}
      {/* CABO! — full-screen announcement with page flash + shake. */}
      {room.caboAnnounce && Date.now() - room.caboAnnounce.at < 3000 && (
        <div className="cabo-announce" key={room.caboAnnounce.at}>
          <span className="cabo-announce-bell">🔔</span>
          <span className="cabo-announce-text">CABO!</span>
          <span className="cabo-announce-by">{room.caboAnnounce.name} called it — final round!</span>
        </div>
      )}
      {room.caboAnnounce && Date.now() - room.caboAnnounce.at < 1400 && <div className="cabo-flash" />}
      {/* The starting peek: a sticky reminder while your cards are flashed. */}
      {myHand.some((id) => {
        const f = room.peekFlash[id];
        return f && f.ms >= 9000 && Date.now() - f.at < f.ms;
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
      {(() => {
        const isHost = room.lobby?.hostId === room.myPlayerId;
        const inGame = !!view.gameId;
        const backToLobby = isHost && inGame;
        return (
          <button
            className={`leave-toggle ${backToLobby ? 'as-endgame' : ''}`}
            onClick={() => {
              if (backToLobby) {
                if (window.confirm('End the current game and return everyone to this room\'s lobby?')) room.endGame();
              } else {
                if (!window.confirm('Leave this room entirely and go home?')) return;
                room.leaveRoom();
                window.location.hash = '#/';
              }
            }}
            aria-label={backToLobby ? 'Back to lobby (end current game)' : 'Leave the room'}
            title={backToLobby ? 'End the current game — everyone returns to the lobby' : 'Leave the room and go home'}
          >
            {backToLobby ? '⏹' : '🚪'}
          </button>
        );
      })()}
      {room.lobby?.hostId === room.myPlayerId && (
        <button
          className="restart-toggle"
          onClick={() => void room.restartGame()}
          aria-label="Restart game"
          title="Restart the game — fresh deal (host)"
        >
          ↻
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
              {room.lobby?.hostId === room.myPlayerId &&
                room.lobby?.players.find((lp) => lp.id === p.id)?.kind !== 'ai' && (
                <button
                  className="autopilot-toggle"
                  onClick={() => room.kickLive(p.id)}
                  aria-label={`Hand ${p.name}'s seat to the autopilot`}
                  title={`Hand ${p.name}'s seat to the autopilot bot (host)`}
                >
                  🤖
                </button>
              )}
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
                          justDrawn={!!room.drawFlash?.[cardId]}
                          seenMarker={!!known && !revealed}
                          contentRotate={-seat.facing}
                          small
                          test={room.testMode}
                          peekedBy={peekedBy(cardId)}
                          swapped={wasSwapped(cardId)}
                          selectable={selectable}
                          onClick={() => onOpponentCardClick(p.id, cardId)}
                        />
                      );
                    })()
                  ),
                )}
              </div>
            </div>
          );
        })}

        {/* opponents' avatar/name pills — OUTSIDE the felt, at the screen
            edges (above for the opposite player, beside for side players). */}
        {others.map((p, i) => {
          const seat = seats[i]!;
          const style = pillStyle(seat);
          if (!style) return null;
          const isTurn = view.players.find((x) => x.isCurrentTurn)?.id === p.id;
          return (
            <button
              key={`pill-${p.id}`}
              className={`seat-who who-${seat.whoSide} ${isTurn ? 'is-turn-pill' : ''}`}
              style={style}
              onClick={() => onOpponentClick(p.id)}
            >
              <Avatar
                avatar={avatarOf(p.id)}
                size={42}
                crown={isTurn}
                ring={isTurn}
                cabo={view.cabo?.callerId === p.id}
              />
              <span className="seat-name">{p.name}</span>
            </button>
          );
        })}

        {/* my avatar/name — pinned below my deck, outside the felt at the bottom
            edge of the screen */}
        <div className="seat-who me-who">
          <Avatar
            avatar={avatarOf(me.id)}
            size={42}
            crown={isMyTurn}
            ring={isMyTurn}
            cabo={view.cabo?.callerId === me.id}
          />
          <span className="seat-name">{me.name} (you)</span>
        </div>

        {/* centre: deck + discard */}
        <TableCenter
          view={view}
          onDraw={
            isMyTurn && phase === 'TURN_DRAW' && myLiveCount > 0
              ? () => act({ type: 'DRAW' })
              : null
          }
          onCallCabo={
            isMyTurn && phase === 'TURN_END' && !view.cabo
              ? () => act({ type: 'CALL_CABO' })
              : null
          }
        />

        {/* End of action: pass the turn. Always available at TURN_END — also
            during the final round after a cabo call (that was the stall). */}
        {mode === 'turn-end' && (
          <button className="end-turn-btn" onClick={() => act({ type: 'END_TURN' })}>
            {view.cabo ? 'Finish round ▸' : 'End turn ▸'}
          </button>
        )}

        {/* flying-card overlay: every player sees where each card went */}
        {anchors && (
          <CardFlights
            flights={flights}
            anchors={anchors}
            myId={me.id}
            onDone={dropFlight}
            seatFallback={Object.fromEntries(
              others.map((p, i) => {
                const st = seats[i % Math.max(seats.length, 1)];
                return [
                  p.id,
                  st
                    ? {
                        x: (anchors.ellipse?.width ?? anchors.size.w) *
                          ((parseFloat(String(st.style.left)) || 50) / 100),
                        y: (anchors.ellipse?.height ?? anchors.size.h) *
                          ((parseFloat(String(st.style.top)) || 40) / 100),
                      }
                    : { x: anchors.size.w / 2, y: anchors.size.h * 0.25 },
                ];
              }),
            )}
          />
        )}
        {anchors && <SwapGhosts ghosts={swapGhosts} size={anchors.size} />}

        {/* my hand */}
        <div className={`seat seat-me ${isMyTurn ? 'active' : ''}`}>
          <FloatingEmote emote={room.emotes[me.id]} />
          <div className="my-hand hand-grid" data-hand-for={me.id}>
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
                      swapped={wasSwapped(cardId)}
                      lifted={mode === 'draw-decision' || mode === 'power-peek-own' || mode === 'transfer'}
                      onClick={() => onMyCardClick(cardId)}
                    />
                  );
                })()
              ),
            )}
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
        </div>
      </div>

      {/* round-over overlay */}
      {mode === 'round-over' && <ScoreBoard view={view} room={room} />}

      <InfoModal open={infoOpen} onClose={() => setInfoOpen(false)} />

      <ChatPanel room={room} floating />
    </div>
  );
}
