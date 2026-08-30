import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RoomApi, CardFlight } from '../useRoom.js';
import type { FlightPos } from '../table/CardFlights.js';
import type { SeepPlayerView } from '@seep/views.js';
import type { SeepTeam } from '@seep/rules.js';
import { intentsForCard, biddableValues } from './seepCandidates.js';
import Card from '../table/Card.js';
import SeepCenter from './SeepCenter.js';
import SeatPlanner, { orderPlayersForViewer } from '../table/SeatPlanner.js';
import CardFlights from '../table/CardFlights.js';
import ChatPanel from '../chat/ChatPanel.js';
import SoundToggle from '../SoundToggle.js';
import EmotePicker from '../EmotePicker.js';
import FloatingEmote from '../table/FloatingEmote.js';
import InfoModal from '../table/InfoModal.js';
import Avatar from '../table/Avatar.js';

/**
 * The Seep table. Same physical room as Cabo — ellipse felt, seats around
 * the arc, flying cards — but the centre holds the open table spread and
 * house stacks, hands sit face-up (you always know your own hand), and the
 * scoreboard is 2v2 team rails.
 */
export default function SeepTable({ room, view }: { room: RoomApi; view: SeepPlayerView }) {
  const me = view.players.find((p) => p.id === room.myPlayerId) ?? view.players[0]!;
  const myTeam: SeepTeam | null = view.myTeam;
  const others = orderPlayersForViewer(view.players, me.id);
  const seats = useMemo(() => SeatPlanner(others.length), [others.length]);
  const isMyTurn = view.players.find((p) => p.isCurrentTurn)?.id === me.id;
  const roundOver = view.phase === 'ROUND_COMPLETE';

  const [infoOpen, setInfoOpen] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [pickedTableIds, setPickedTableIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // ---- Sweep announcement (event-watching) ------------------------------
  const lastEventSeq = useRef(0);
  const [sweepAnnounce, setSweepAnnounce] = useState<{ by: string; bonus: number; at: number } | null>(null);
  useLayoutEffect(() => {
    for (const ev of view.events) {
      if (ev.seq <= lastEventSeq.current) continue;
      lastEventSeq.current = ev.seq;
      if (ev.type === 'SEEP_SWEEP') {
        const payload = (ev.payload ?? {}) as Record<string, unknown>;
        const pid = payload.playerId;
        const name = view.players.find((p) => p.id === String(pid))?.name ?? 'Someone';
        const bonus = typeof payload.bonus === 'number' ? payload.bonus : 50;
        setSweepAnnounce({ by: name, bonus, at: Date.now() });
        window.setTimeout(() => setSweepAnnounce((cur) => (cur && Date.now() - cur.at >= 2600 ? null : cur)), 2600);
      }
    }
  }, [view.events, view.players]);

  // Clear stale selections whenever the view advances.
  useLayoutEffect(() => {
    if (!isMyTurn) {
      setSelectedCardId(null);
      setPickedTableIds([]);
    }
    setError(null);
  }, [isMyTurn, view.revision]);

  // ---- Pixel anchors for flights (same measurement approach as Cabo) ----
  const tableRef = useRef<HTMLDivElement>(null);
  const [anchors, setAnchors] = useState<{
    size: { w: number; h: number };
    ellipse: { left: number; top: number; width: number; height: number } | null;
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
    const centre = (el: Element | null): FlightPos | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - rect.left + r.width / 2, y: r.top - rect.top + r.height / 2 };
    };
    const hands: Record<string, FlightPos> = {};
    table.querySelectorAll<HTMLElement>('[data-hand-for]').forEach((el) => {
      const pid = el.dataset.handFor;
      const pos = centre(el);
      if (pid && pos) hands[pid] = pos;
    });
    setAnchors({
      size: { w: rect.width, h: rect.height },
      ellipse: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      deck: centre(table.querySelector('.seep-deck .deck-stack.s3')) ?? centre(table.querySelector('.seep-deck')) ?? { x: rect.width * 0.3, y: rect.height * 0.42 },
      discard: centre(table.querySelector('.seep-spread')) ?? { x: rect.width * 0.5, y: rect.height * 0.46 },
      draw: centre(table.querySelector('.seat-me')) ?? { x: rect.width * 0.5, y: rect.height * 0.9 },
      hands,
      cards: (() => {
        const cards: Record<string, FlightPos> = {};
        table.querySelectorAll<HTMLElement>('[data-card-id]').forEach((el) => {
          const cid = el.dataset.cardId;
          const r = el.getBoundingClientRect();
          if (cid) cards[cid] = { x: r.left - rect.left + r.width / 2, y: r.top - rect.top + r.height / 2 };
        });
        return cards;
      })(),
    });
  }, []);
  useLayoutEffect(() => {
    measureAnchors();
    const onResize = () => measureAnchors();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measureAnchors, view.revision, others.length]);

  // ---- Flights: adopt the room's derived flight stream locally -----------
  const [flights, setFlights] = useState<CardFlight[]>([]);
  const seenFlightIds = useRef<Set<string>>(new Set());
  useLayoutEffect(() => {
    const fresh = room.flights.filter((f) => !seenFlightIds.current.has(f.id));
    if (fresh.length === 0) return;
    fresh.forEach((f) => seenFlightIds.current.add(f.id));
    measureAnchors();
    setFlights((cur) => {
      const existing = new Set(cur.map((f) => f.id));
      const additions = fresh.filter((f) => !existing.has(f.id));
      if (additions.length === 0) return cur;
      return [...cur, ...additions].slice(-32);
    });
  }, [room.flights, measureAnchors]);
  const dropFlight = useCallback((id: string) => {
    setFlights((cur) => cur.filter((f) => f.id !== id));
  }, []);

  // ---- Intents for the selected card ------------------------------------
  const intents = useMemo(
    () => (selectedCardId && isMyTurn ? intentsForCard(view, selectedCardId, me.id) : null),
    [view, selectedCardId, isMyTurn, me.id],
  );

  // Auto-highlight a single candidate set; otherwise let the user pick.
  const singleCapture = intents && intents.captures.length === 1 ? intents.captures[0]! : null;
  const activeCaptureSet =
    singleCapture ??
    intents?.captures.find(
      (set) => set.length === pickedTableIds.length && set.every((id) => pickedTableIds.includes(id)),
    ) ?? null;
  const activeBuild = (() => {
    if (!intents) return null;
    const exact = intents.builds.find(
      (b) =>
        b.tableCardIds.length === pickedTableIds.length &&
        b.tableCardIds.every((id) => pickedTableIds.includes(id)),
    );
    if (exact) return exact;
    return intents.builds.length === 1 ? intents.builds[0]! : null;
  })();
  const highlightedTableIds = new Set<string>([
    ...(activeCaptureSet ?? []),
    ...(activeBuild && !activeCaptureSet ? activeBuild.tableCardIds : []),
    ...pickedTableIds,
  ]);
  const highlightedHouseIds = new Set<string>([
    ...(intents?.capturableHouseIds ?? []),
    ...(intents?.addableHouses.map((a) => a.houseId) ?? []),
    ...(intents?.breakableHouses.map((b) => b.houseId) ?? []),
  ]);

  const act = (action: Parameters<RoomApi['sendAction']>[0]) => {
    void room.sendAction(action).then((res) => {
      if (!res.ok && res.error) setError(res.error);
    });
    setSelectedCardId(null);
    setPickedTableIds([]);
  };

  const onMyCardClick = (cardId: string) => {
    if (!isMyTurn) return;
    if (selectedCardId === cardId) {
      // Re-tap the selected card: play its obvious default (single capture).
      const it = intentsForCard(view, cardId, me.id);
      if (it.captures.length === 1) {
        act({ type: 'PLAY_CARD', cardId, intent: { kind: 'CAPTURE', tableCardIds: it.captures[0]!, houseIds: [] } });
      }
      return;
    }
    setSelectedCardId(cardId);
    setPickedTableIds([]);
  };

  const onTableCardClick = (cardId: string) => {
    if (!isMyTurn || !selectedCardId) return;
    setPickedTableIds((cur) =>
      cur.includes(cardId) ? cur.filter((x) => x !== cardId) : [...cur, cardId],
    );
  };

  const onHouseClick = (houseId: string) => {
    if (!isMyTurn || !selectedCardId) return;
    const it = intentsForCard(view, selectedCardId, me.id);
    if (it.capturableHouseIds.includes(houseId)) {
      const set = activeCaptureSet ?? [];
      act({ type: 'PLAY_CARD', cardId: selectedCardId, intent: { kind: 'CAPTURE', tableCardIds: set, houseIds: [houseId] } });
      return;
    }
    const addable = it.addableHouses.find((a) => a.houseId === houseId);
    if (addable) {
      act({ type: 'PLAY_CARD', cardId: selectedCardId, intent: { kind: 'ADD_TO_HOUSE', houseId, tableCardIds: addable.tableCardIds } });
      return;
    }
    const breakable = it.breakableHouses.find((b) => b.houseId === houseId);
    if (breakable) {
      act({ type: 'PLAY_CARD', cardId: selectedCardId, intent: { kind: 'BREAK_HOUSE', houseId } });
    }
  };

  const statusText = (() => {
    if (view.phase === 'ANNOUNCE') {
      if (isMyTurn) return 'Announce a number 9–13 that you hold — the table then turns up.';
      return `${view.players.find((p) => p.isCurrentTurn)?.name ?? 'The opener'} is announcing…`;
    }
    if (roundOver) return 'Deal complete — leftovers went to the team that captured last.';
    if (isMyTurn) {
      if (!selectedCardId) return 'Your turn — tap a card to see what it can do.';
      if (activeCaptureSet) return 'Tap Capture to take the highlighted cards.';
      if (intents && intents.captures.length > 1) return 'Tap the exact table cards you want, then Capture.';
      if (intents && intents.capturableHouseIds.length > 0) return 'Tap a highlighted ghar to capture it.';
      if (activeBuild) return `Build a ghar of ${activeBuild.total}?`;
      if (intents && intents.builds.length > 1) return 'Pick the cards to build with, then choose Build.';
      if (intents && intents.addableHouses.length > 0) return 'Tap your ghar to add this card to it.';
      if (intents && intents.breakableHouses.length > 0) return 'Tap their kachcha ghar to break it upward.';
      if (intents && intents.canLay) return 'Nothing to capture — lay it down.';
      return 'Your turn.';
    }
    const turn = view.players.find((p) => p.isCurrentTurn);
    return `${turn?.name ?? 'Someone'}'s turn…`;
  })();

  const avatarOf = (pid: string) =>
    room.lobby?.players.find((p) => p.id === pid)?.avatar ?? { color: 0, eyes: 0, mouth: 0, hat: 0 };

  const pillStyle = (seat: (typeof seats)[number] | undefined): CSSProperties | undefined => {
    const ell = anchors?.ellipse;
    if (!ell || !seat) return undefined;
    const lx = parseFloat(String(seat.style.left));
    const ty = parseFloat(String(seat.style.top));
    const sx = ell.left + (lx / 100) * ell.width;
    const sy = ell.top + (ty / 100) * ell.height;
    switch (seat.whoSide) {
      case 'above':
        return { left: sx, top: Math.max(10, sy - 82), transform: 'translateX(-50%)' };
      case 'left':
        return { right: 18, top: sy, transform: 'translateY(-50%)' };
      case 'right':
        return { left: 18, top: sy, transform: 'translateY(-50%)' };
      default:
        return undefined;
    }
  };

  const myHand = (view.handCardIds[me.id] ?? []).filter((id) => !!view.knownCards[id]);
  const teamLabel = (team: SeepTeam | null) => (team === null ? '' : team === 0 ? 'Team A' : 'Team B');

  return (
    <div className="table-room">
      <div className={`status-banner ${error ? 'urgent' : ''}`}>{error ?? statusText}</div>
      {room.testMode && <div className="test-banner">TEST MODE — all cards revealed</div>}
      {sweepAnnounce && (
        <div className="seep-announce" key={sweepAnnounce.at}>
          <span className="seep-announce-icon">✨</span>
          <span className="seep-announce-text">SEEP!</span>
          <span className="seep-announce-by">
            {sweepAnnounce.by} swept the table{sweepAnnounce.bonus > 0 ? ` — +${sweepAnnounce.bonus}!` : ' (final card — no bonus)'}
          </span>
        </div>
      )}
      {(() => {
        const isHost = room.lobby?.hostId === room.myPlayerId;
        return (
          <>
            {isHost && (
              <button
                className={`test-toggle ${room.testMode ? 'on' : ''}`}
                onClick={() => room.setTestMode(!room.testMode)}
                title={room.testMode ? 'Turn off Test Mode' : 'Turn on Test Mode (see every card)'}
                aria-label="Toggle Test Mode"
              >
                {room.testMode ? 'TEST ON' : 'TEST'}
              </button>
            )}
            {isHost && (
              <button
                className="restart-toggle"
                onClick={() => void room.restartGame()}
                aria-label="Restart game"
                title="Restart the game — fresh deal (host)"
              >
                ↻
              </button>
            )}
            <button
              className={`leave-toggle ${isHost ? 'as-endgame' : ''}`}
              onClick={() => {
                if (isHost) {
                  if (window.confirm('End the current game and return everyone to this room\'s lobby?')) room.endGame();
                } else {
                  if (!window.confirm('Leave this room entirely and go home?')) return;
                  room.leaveRoom();
                  window.location.hash = '#/';
                }
              }}
              aria-label={isHost ? 'Back to lobby (end current game)' : 'Leave the room'}
            >
              {isHost ? '⏹' : '🚪'}
            </button>
          </>
        );
      })()}
      <SoundToggle />
      <EmotePicker room={room} />
      <button className="info-toggle" onClick={() => setInfoOpen(true)} aria-label="Rules" title="How to play">
        ❓
      </button>

      <div className="table-ellipse" ref={tableRef}>
        <div className="table-felt" />

        {/* opponents around the arc — face-down card backs with live counts */}
        {others.map((p, i) => {
          const seat = seats[i]!;
          const isTurn = view.players.find((x) => x.isCurrentTurn)?.id === p.id;
          const team = view.teams[0].includes(p.id) ? 0 : 1;
          const count = view.handCounts[p.id] ?? 0;
          return (
            <div
              key={p.id}
              className={`seat seat-opponent ${isTurn ? 'active' : ''}`}
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
                className="hand-shell"
                data-hand-for={p.id}
                style={seat.facing ? { transform: `rotate(${seat.facing}deg)` } : undefined}
              >
                <div className="seep-opponent-cards">
                  {Array.from({ length: Math.min(count, 4) }, (_, k) => (
                    <Card key={k} cardId={`${p.id}-back-${k}`} card={null} faceDown small />
                  ))}
                  {count > 4 && <span className="seep-more">+{count - 4}</span>}
                  {count === 0 && <span className="seep-more">out</span>}
                </div>
                <span className={`seep-team-chip team${team}`}>T{team + 1}</span>
              </div>
            </div>
          );
        })}

        {/* avatar/name pills outside the felt */}
        {others.map((p, i) => {
          const seat = seats[i]!;
          const style = pillStyle(seat);
          if (!style) return null;
          const isTurn = view.players.find((x) => x.isCurrentTurn)?.id === p.id;
          const team = view.teams[0].includes(p.id) ? 0 : 1;
          return (
            <div
              key={`pill-${p.id}`}
              className={`seat-who who-${seat.whoSide} ${isTurn ? 'is-turn-pill' : ''}`}
              style={style}
            >
              <Avatar avatar={avatarOf(p.id)} size={42} crown={isTurn} ring={isTurn} />
              <span className="seat-name">
                {p.name}
                <span className={`seep-pill-team team${team}`}>{teamLabel(team)}</span>
              </span>
            </div>
          );
        })}

        {/* my avatar */}
        <div className="seat-who me-who">
          <Avatar
            avatar={avatarOf(me.id)}
            size={42}
            crown={isMyTurn}
            ring={isMyTurn}
          />
          <span className="seat-name">
            {me.name} (you)
            <span className={`seep-pill-team team${myTeam ?? 0}`}>{teamLabel(myTeam)}</span>
          </span>
        </div>

        {/* centre: rails + stock + spread + houses */}
        <SeepCenter
          view={view}
          myTeam={myTeam}
          pickedTableIds={[...highlightedTableIds]}
          highlightHouseIds={[...highlightedHouseIds]}
          selectedCardId={selectedCardId}
          onTableCardClick={isMyTurn && selectedCardId ? onTableCardClick : undefined}
          onHouseClick={isMyTurn && selectedCardId ? onHouseClick : undefined}
        />

        {/* flying-card overlay */}
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

        {/* my hand — always face-up in Seep */}
        <div className={`seat seat-me ${isMyTurn ? 'active' : ''}`}>
          <FloatingEmote emote={room.emotes[me.id]} />
          <div className="hand-shell hand-shell-me" data-hand-for={me.id}>
            <div className="seep-my-hand">
              {myHand.map((cardId) => (
                <Card
                  key={cardId}
                  cardId={cardId}
                  card={view.knownCards[cardId] ?? null}
                  highlight={selectedCardId === cardId}
                  lifted={isMyTurn}
                  onClick={() => onMyCardClick(cardId)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* announce bar: the opener names their number */}
      {view.phase === 'ANNOUNCE' && isMyTurn && (
        <div className="seep-action-bar seep-announce-bar">
          <span className="seep-act-hint">Announce a number you hold:</span>
          {biddableValues(view, me.id).map((value) => (
            <button
              key={value}
              className="seep-act build"
              onClick={() => act({ type: 'ANNOUNCE', value } as Parameters<RoomApi['sendAction']>[0])}
            >
              {value}
            </button>
          ))}
        </div>
      )}

      {/* action bar */}
      {isMyTurn && !roundOver && view.phase === 'TURN_PLAY' && (
        <div className="seep-action-bar">
          {selectedCardId ? (
            <>
              <span className="seep-action-with">
                playing <strong>{view.knownCards[selectedCardId]
                  ? `${RANK_SHORT(view.knownCards[selectedCardId]!)}`
                  : '?'}</strong>
              </span>
              {activeCaptureSet && (
                <button
                  className="seep-act capture"
                  onClick={() =>
                    act({ type: 'PLAY_CARD', cardId: selectedCardId, intent: { kind: 'CAPTURE', tableCardIds: activeCaptureSet, houseIds: [] } })
                  }
                >
                  🫳 Capture {activeCaptureSet.length + 1} card{activeCaptureSet.length + 1 === 1 ? '' : 's'}
                </button>
              )}
              {intents && intents.captures.length > 1 && !activeCaptureSet && (
                <span className="seep-act-hint">tap the table cards to group…</span>
              )}
              {intents?.capturableHouseIds.map((houseId) => {
                const house = view.houses.find((h) => h.id === houseId);
                return (
                  <button
                    key={houseId}
                    className="seep-act capture"
                    onClick={() =>
                      act({
                        type: 'PLAY_CARD',
                        cardId: selectedCardId,
                        intent: { kind: 'CAPTURE', tableCardIds: activeCaptureSet ?? [], houseIds: [houseId] },
                      })
                    }
                  >
                    🏠 Take ghar {house?.total}{house?.pakka ? ' 🔒' : ''}
                  </button>
                );
              })}
              {activeBuild && (
                <button
                  className="seep-act build"
                  onClick={() =>
                    act({
                      type: 'PLAY_CARD',
                      cardId: selectedCardId,
                      intent: { kind: 'BUILD', tableCardIds: activeBuild.tableCardIds, total: activeBuild.total },
                    })
                  }
                >
                  🏗 Build ghar {activeBuild.total}
                </button>
              )}
              {intents?.addableHouses.map(({ houseId, tableCardIds }) => {
                const house = view.houses.find((h) => h.id === houseId);
                return (
                  <button
                    key={`add-${houseId}`}
                    className="seep-act build"
                    onClick={() =>
                      act({ type: 'PLAY_CARD', cardId: selectedCardId, intent: { kind: 'ADD_TO_HOUSE', houseId, tableCardIds } })
                    }
                  >
                    ⬆ Add to ghar {house?.total}{house?.sets === 1 ? ' (make pakka)' : ''}
                  </button>
                );
              })}
              {intents?.breakableHouses.map(({ houseId, newTotal }) => (
                <button
                  key={`break-${houseId}`}
                  className="seep-act break"
                  onClick={() => act({ type: 'PLAY_CARD', cardId: selectedCardId, intent: { kind: 'BREAK_HOUSE', houseId } })}
                >
                  💥 Break to ghar {newTotal}
                </button>
              ))}
              {intents?.canLay && (
                <button
                  className="seep-act lay"
                  onClick={() => act({ type: 'PLAY_CARD', cardId: selectedCardId, intent: { kind: 'LAY_DOWN' } })}
                >
                  🂠 Lay down
                </button>
              )}
              <button className="seep-act cancel" onClick={() => { setSelectedCardId(null); setPickedTableIds([]); }}>
                ✕
              </button>
            </>
          ) : (
            <span className="seep-act-hint">Tap one of your cards to begin.</span>
          )}
        </div>
      )}

      {/* round-over overlay */}
      {roundOver && <SeepRoundSummary view={view} room={room} />}

      <InfoModal open={infoOpen} onClose={() => setInfoOpen(false)} game="seep" />
      <ChatPanel room={room} floating />
    </div>
  );
}

function RANK_SHORT(card: { rank: number; suit: string }): string {
  const labels = ['?', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const glyph = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' }[card.suit] ?? '';
  return `${labels[card.rank] ?? '?'}${glyph}`;
}

/** Deal-end overlay: team result + running match totals. */
function SeepRoundSummary({ view, room }: { view: SeepPlayerView; room: RoomApi }) {
  const result = view.roundResult;
  const isHost = room.lobby?.hostId === room.myPlayerId;
  if (!result) return null;
  const nameOf = (id: string) => view.players.find((p) => p.id === id)?.name ?? id;
  const teamNames = (team: SeepTeam) => view.teams[team].map(nameOf).join(' & ');
  return (
    <div className="round-overlay">
      <div className="round-card">
        <h2 className="font-display round-title">Deal complete</h2>
        {result.winnerTeam !== null ? (
          <p className="round-winner">🏆 {teamNames(result.winnerTeam)} win the deal!</p>
        ) : (
          <p className="round-winner">🤝 Dead heat — {result.teamScores[0]} : {result.teamScores[1]}</p>
        )}
        <div className="seep-result-teams">
          {([0, 1] as SeepTeam[]).map((team) => (
            <div key={team} className={`seep-result-rail team${team} ${result.winnerTeam === team ? 'winner' : ''}`}>
              <span className="seep-result-names">{teamNames(team)}</span>
              <span className="seep-result-points">{result.teamScores[team]}</span>
              <span className="seep-result-sweeps">
                {result.majorityTeam === team && <span title="More captured cards (+4)">🃏 </span>}
                {view.sweeps[team] > 0 ? `✨ ${view.sweeps[team]} sweep${view.sweeps[team] > 1 ? 's' : ''}` : ''}
              </span>
            </div>
          ))}
        </div>
        <p className="seep-result-note">spades face value · aces 1 · 10♦ 2 · most cards +4 · sweeps +50</p>
        {Object.keys(room.lobby?.scoreboard ?? {}).length > 0 && (
          <div className="match-scores">
            <span className="match-title">Match totals</span>
            {Object.entries(room.lobby?.scoreboard ?? {})
              .sort((a, b) => b[1] - a[1])
              .map(([id, total]) => (
                <span key={id} className="match-entry">
                  {nameOf(id)} <strong>{total}</strong>
                </span>
              ))}
          </div>
        )}
        {isHost ? (
          <div className="round-actions">
            <button onClick={() => void room.playAgain()}>Play Again</button>
            <button className="ghost" onClick={() => room.returnToLobby()}>
              Return to Lobby
            </button>
          </div>
        ) : (
          <p className="waiting-host">Waiting for the host…</p>
        )}
      </div>
    </div>
  );
}
