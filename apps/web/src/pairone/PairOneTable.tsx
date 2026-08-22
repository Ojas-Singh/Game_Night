import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { RoomApi } from '../useRoom.js';
import type { PairOnePlayerView } from '@pairone/views.js';
import type { Card } from '@shared/cards.js';
import { RANK_LABELS } from '@shared/cards.js';
import Avatar from '../table/Avatar.js';
import FloatingEmote from '../table/FloatingEmote.js';
import InfoModal from '../table/InfoModal.js';
import ChatPanel from '../chat/ChatPanel.js';
import SoundToggle from '../SoundToggle.js';
import EmotePicker from '../EmotePicker.js';
import { playSound } from '../sound.js';

type Props = { room: RoomApi; view: PairOnePlayerView };

const SUIT_GLYPH: Record<string, string> = {
  spades: '♠',
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
};

interface CollectFx {
  id: string;
  fromA: { x: number; y: number };
  fromB: { x: number; y: number };
  to: { x: number; y: number };
  cardA: Card;
  cardB: Card;
}

/** Total cards on the table (two decks). */
const GRID_CARDS = 104;
/** Card height = width × this (matches the 5/7 slot aspect ratio in CSS). */
const CARD_ASPECT = 1.4;

export interface PoLayout {
  cols: number;
  cardW: number;
  gap: number;
}

/**
 * Fit ALL 104 cards inside the visible felt — never scroll, never reflow
 * mid-round. Only column counts that divide 104 are considered (26×4, 13×8,
 * 8×13, 4×26 …), so the grid is ALWAYS a perfect, unchanging rectangle: the
 * same wall from deal to finish, which is what makes positions memorable.
 * Among those, whichever layout yields the largest card wins.
 */
const GRID_COL_OPTIONS = [26, 13, 8, 4]; // divisors of 104, wide → tall

function computeLayout(width: number, height: number): PoLayout {
  const w = Math.max(120, width);
  const h = Math.max(120, height);
  const gap = Math.max(3, Math.min(12, Math.sqrt((w * h) / GRID_CARDS) * 0.16));
  let best: PoLayout = { cols: 13, cardW: 0, gap };
  for (const cols of GRID_COL_OPTIONS) {
    const rows = GRID_CARDS / cols;
    const byWidth = (w - (cols - 1) * gap) / cols;
    const byHeight = (h - (rows - 1) * gap) / rows / CARD_ASPECT;
    const cardW = Math.min(byWidth, byHeight);
    if (cardW > best.cardW) best = { cols, cardW, gap };
  }
  // Integer size (what CSS renders) and a cap so huge screens get a centred
  // table, not giant cards.
  best.cardW = Math.floor(Math.min(best.cardW, 96));
  return best;
}

/**
 * Pair One — two decks shuffled into one big face-down grid. Flip two cards
 * (everyone sees them): matching numbers → collect the pair and go again;
 * a miss flips them back and passes the turn. Most pairs when the grid
 * empties wins.
 */
export default function PairOneTable({ room, view }: Props) {
  const me = view.players.find((p) => p.id === room.myPlayerId) ?? view.players[0]!;
  const isMyTurn = view.players.find((p) => p.isCurrentTurn)?.id === me.id;
  const roundOver = view.phase === 'ROUND_COMPLETE';

  // ---- Refs & measured positions -----------------------------------------
  const boardRef = useRef<HTMLDivElement>(null);
  // Flight ghosts render position:fixed → measure VIEWPORT centres.
  const vpCenter = useCallback(
    (el: Element | null | undefined): { x: number; y: number } | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    [],
  );
  const slotCenter = useCallback(
    (index: number) => vpCenter(boardRef.current?.querySelector(`[data-slot="${index}"]`)),
    [vpCenter],
  );
  const chipCenter = useCallback(
    (playerId: string) => vpCenter(document.querySelector(`[data-chip="${playerId}"]`)),
    [vpCenter],
  );

  // ---- Fit-the-whole-grid layout (no scrolling, ever) ----------------------
  const feltRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<PoLayout>(() =>
    computeLayout(
      typeof window === 'undefined' ? 1200 : window.innerWidth * 0.94,
      typeof window === 'undefined' ? 700 : Math.max(320, window.innerHeight - 190),
    ),
  );
  useLayoutEffect(() => {
    const el = feltRef.current;
    if (!el) return;
    // ResizeObserver fires once on observe — its contentRect excludes the
    // felt's padding, which is exactly the space the grid may occupy.
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box && box.width > 0 && box.height > 0) setLayout(computeLayout(box.width, box.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- Turn reveal lifecycle (deterministic, event-driven) -----------------
  // The server resolves a turn's second flip INSTANTLY, so faceUpCardIds is
  // empty again by the time clients see the resolution. Everything a viewer
  // must still SEE is reconstructed here from the event log:
  //   • miss  → BOTH cards stay face-up for MISS_HOLD_MS, then close together
  //   • match → face-up collected ghosts + flights (see below)
  const MISS_HOLD_MS = 1700;
  /** My own in-flight flips — open instantly on click, no round-trip wait. */
  const [myFlips, setMyFlips] = useState<string[]>([]);
  /** A failed pair: both ids held face-up until one shared timer closes them. */
  const [missPair, setMissPair] = useState<{ ids: string[]; at: number } | null>(null);
  const handledMisses = useRef<Set<number>>(new Set());
  useEffect(() => {
    const fresh = view.events.filter(
      (e) => e.type === 'PAIR_MISSED' && !handledMisses.current.has(e.seq),
    );
    if (fresh.length === 0) return;
    for (const e of fresh) handledMisses.current.add(e.seq);
    const last = fresh[fresh.length - 1]!;
    const ids = ((last.payload as { cardIds?: string[] }).cardIds ?? []).filter(Boolean);
    if (ids.length === 0) return;
    setMissPair({ ids, at: Date.now() });
  }, [view.events]);
  useEffect(() => {
    if (!missPair) return;
    const t = setTimeout(() => setMissPair(null), MISS_HOLD_MS);
    return () => clearTimeout(t);
  }, [missPair]);
  // Clear my optimistic flips once the server has caught up (resolution seen,
  // or its faceUp set emptied/matched my clicks).
  useEffect(() => {
    if (myFlips.length === 0) return;
    const resolved =
      view.faceUpCardIds.length === 0 ||
      view.events.some((e) => e.type === 'PAIR_MISSED' || e.type === 'PAIR_COLLECTED');
    if (!resolved) return;
    const t = setTimeout(() => setMyFlips([]), 250);
    return () => clearTimeout(t);
  }, [view.events, view.faceUpCardIds.length, myFlips.length]);

  const flashActive = (cardId: string): boolean => {
    const f = room.peekFlash[cardId];
    return !!f && Date.now() - f.at < f.ms;
  };
  const [, forceTick] = useState(0);
  // Re-render when pending windows expire so cards flip back down.
  useEffect(() => {
    const iv = setInterval(() => forceTick((n) => n + 1), 300);
    return () => clearInterval(iv);
  }, []);

  // ---- Match collection flights -------------------------------------------
  const handledCollections = useRef<Set<number>>(new Set());
  const [collectFx, setCollectFx] = useState<CollectFx[]>([]);
  /**
   * The server resolves the second flip instantly: a matched card leaves the
   * grid in the SAME view update that would first show it face-up. An exit
   * animation would freeze on the stale face-down render, so instead we keep
   * an explicit face-up "collected ghost" in each vacated slot for ~0.8s.
   */
  const [collectedGhosts, setCollectedGhosts] = useState<Record<number, { cardId: string; at: number }>>({});
  useEffect(() => {
    const fresh = view.events.filter(
      (e) => e.type === 'PAIR_COLLECTED' && !handledCollections.current.has(e.seq),
    );
    if (fresh.length === 0) return;
    const created: CollectFx[] = [];
    const ghosts: Array<[number, string]> = [];
    const at = Date.now();
    for (const ev of fresh) {
      handledCollections.current.add(ev.seq);
      const p = ev.payload as { indexes?: number[]; cardIds?: string[] };
      const [idxA, idxB] = p.indexes ?? [];
      const [idA, idB] = p.cardIds ?? [];
      if (idxA === undefined || idxB === undefined || !idA || !idB) continue;
      if (view.knownCards[idA] && view.knownCards[idB]) ghosts.push([idxA, idA], [idxB, idB]);
      const fromA = slotCenter(idxA);
      const fromB = slotCenter(idxB);
      const to = chipCenter(String(ev.playerId ?? ''));
      const cardA = view.knownCards[idA];
      const cardB = view.knownCards[idB];
      if (!fromA || !fromB || !to || !cardA || !cardB) continue;
      created.push({ id: `collect-${ev.seq}`, fromA, fromB, to, cardA, cardB });
    }
    if (ghosts.length > 0) {
      setCollectedGhosts((cur) => {
        const next = { ...cur };
        for (const [idx, id] of ghosts) next[idx] = { cardId: id, at };
        return next;
      });
    }
    if (created.length === 0) return;
    setCollectFx((cur) => [...cur, ...created].slice(-4));
    const t = setTimeout(() => {
      setCollectFx((cur) => cur.filter((f) => !created.some((c) => c.id === f.id)));
    }, 1100);
    return () => clearTimeout(t);
  }, [view.events, view.knownCards, slotCenter, chipCenter]);
  useEffect(() => {
    if (Object.keys(collectedGhosts).length === 0) return;
    const t = setTimeout(() => setCollectedGhosts({}), 850);
    return () => clearTimeout(t);
  }, [collectedGhosts]);

  // ---- Guidance line --------------------------------------------------------
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 2600);
    return () => clearTimeout(t);
  }, [error]);

  const current = view.players.find((p) => p.isCurrentTurn);
  const currentName = current?.name ?? '…';
  const statusText = useMemo((): { text: string; urgent: boolean } => {
    if (error) return { text: error, urgent: true };
    if (missPair) return { text: 'No match!', urgent: true };
    if (roundOver) return { text: 'Round over — check the scores!', urgent: false };
    if (view.faceUpCardIds.length === 1) {
      return isMyTurn
        ? { text: 'One card up — pick another!', urgent: true }
        : { text: `${currentName} picks another card…`, urgent: false };
    }
    if (isMyTurn) return { text: 'Your turn — flip any two cards', urgent: true };
    return { text: `${currentName} is flipping…`, urgent: false };
  }, [error, missPair, roundOver, view.faceUpCardIds.length, isMyTurn, currentName]);

  const act = useCallback(
    (cardId: string) => {
      // Optimistic: show MY flip the instant I click — the server view will
      // confirm it moments later. Roll back if the action is rejected.
      setMyFlips((cur) => (cur.includes(cardId) ? cur : [...cur, cardId]));
      void room.sendAction({ type: 'FLIP_CARD', cardId }).then((res) => {
        if (!res.ok && res.error) {
          playSound('error');
          setError(res.error);
          setMyFlips((cur) => cur.filter((id) => id !== cardId));
        }
      });
    },
    [room],
  );

  // ---- Avatars ---------------------------------------------------------------
  const fallbackAvatar = { color: 0, eyes: 0, mouth: 0, hat: 0 };
  const avatarOf = (pid: string) =>
    room.lobby?.players.find((p) => p.id === pid)?.avatar ?? fallbackAvatar;

  const isHost = room.lobby?.hostId === room.myPlayerId;

  // Grid slots: placeholders keep collected gaps, so positions stay stable.
  const slots = view.gridCardIds.map((slotId, index) => ({ slotId, index }));
  const remaining = view.remainingCount;

  return (
    <div className="table-room po-room">
      {/* top-left controls (shared styles) */}
      <button
        className="leave-toggle"
        onClick={() => {
          room.leaveRoom();
          window.location.hash = '#/';
        }}
        aria-label="Leave the game"
        title="Leave the game and go home"
      >
        🚪
      </button>
      {isHost && (
        <button
          className="restart-toggle"
          onClick={() => void room.restartGame()}
          aria-label="Restart game"
          title="Restart the game — fresh shuffle (host)"
        >
          ↻
        </button>
      )}
      <SoundToggle />
      <EmotePicker room={room} />
      <InfoButton />

      {room.testMode && <div className="test-banner">TEST MODE — all cards revealed</div>}

      {/* player chips */}
      <div className="po-players" role="status">
        {view.players.map((p) => {
          const pairs = p.cardCount;
          return (
            <div
              key={p.id}
              data-chip={p.id}
              className={`po-chip ${p.isCurrentTurn ? 'turn' : ''}`}
            >
              <FloatingEmote emote={room.emotes[p.id]} />
              <Avatar avatar={avatarOf(p.id)} size={34} crown={p.isCurrentTurn} ring={p.isCurrentTurn} />
              <span className="po-chip-name">
                {p.name}
                {p.id === me.id ? ' (you)' : ''}
              </span>
              <span className="po-chip-pairs" title={`${pairs} pair${pairs === 1 ? '' : 's'} collected`}>
                <span className="po-chip-pair-count" key={pairs}>
                  {pairs}
                </span>
                <span className="po-chip-pair-icon">pair{(p.cardCount ?? 0) === 1 ? '' : 's'}</span>
              </span>
            </div>
          );
        })}
      </div>

      {/* remaining pill */}
      {!roundOver && (
        <div className="po-remaining">
          <span className="po-remaining-num">{remaining}</span> cards left
        </div>
      )}

      {/* status banner */}
      <div className={`status-banner ${statusText.urgent ? 'urgent' : ''}`}>{statusText.text}</div>

      {/* the grid */}
      <div className={`po-board-wrap ${isMyTurn && !roundOver ? 'my-turn' : ''}`}>
        <div className="po-felt" ref={feltRef}>
          <div
            className="po-grid"
            ref={boardRef}
            style={{
              ['--po-cols' as string]: layout.cols,
              ['--po-card-w' as string]: `${Math.floor(layout.cardW)}px`,
              ['--po-gap' as string]: `${layout.gap}px`,
            }}
          >
            {slots.map(({ slotId, index }) => {
              const isEmpty = slotId.startsWith('__empty__');
              const card = isEmpty ? null : view.knownCards[slotId] ?? null;
              // Face-up when: flipped this turn, still inside its reveal
              // window, or Test Mode (which exposes every value server-side).
              const midTurnUp = !isEmpty && view.faceUpCardIds.includes(slotId);
              const missHeld = !!missPair && missPair.ids.includes(slotId);
              const faceUp =
                !isEmpty &&
                (midTurnUp || myFlips.includes(slotId) || missHeld || flashActive(slotId) || room.testMode);
              const missed = missHeld;
              const clickable =
                !isEmpty &&
                !roundOver &&
                isMyTurn &&
                view.faceUpCardIds.length < 2 &&
                !midTurnUp &&
                !myFlips.includes(slotId);
              const ghostEntry = collectedGhosts[index];
              const ghostCard =
                isEmpty && ghostEntry && Date.now() - ghostEntry.at < 850
                  ? view.knownCards[ghostEntry.cardId] ?? null
                  : null;
              return (
                <div className="po-slot" key={index} data-slot={index}>
                  {!isEmpty && (
                    <motion.div
                      key={slotId}
                      className={`pcard po-card ${faceUp ? 'faceup' : 'facedown'} ${
                        clickable ? 'clickable' : ''
                      } ${missed ? 'missed' : ''} ${room.testMode ? 'test' : ''} ${
                        card ? 'known' : ''
                      }`}
                      initial={{ opacity: 0, scale: 0.5, y: -14 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      transition={{ type: 'spring', stiffness: 340, damping: 26 }}
                      onClick={clickable ? () => act(slotId) : undefined}
                      role={clickable ? 'button' : undefined}
                      aria-label={
                        faceUp && card
                          ? `${RANK_LABELS[card.rank]} of ${card.suit}`
                          : 'face-down card'
                      }
                    >
                      <div className="pcard-inner">
                        <div className="pcard-face po-front">
                          {card ? (
                            <>
                              <span className={`po-corner tl ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : ''}`}>
                                {RANK_LABELS[card.rank]}
                              </span>
                              <span className={`po-rank ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : ''}`}>
                                {RANK_LABELS[card.rank]}
                                <em>{SUIT_GLYPH[card.suit]}</em>
                              </span>
                              <span className={`po-corner br ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : ''}`}>
                                {RANK_LABELS[card.rank]}
                              </span>
                            </>
                          ) : (
                            <span className="unknown">?</span>
                          )}
                        </div>
                        <div className="pcard-back po-back">
                          <div className="back-pattern" />
                          <span className="po-back-mark">1×2</span>
                        </div>
                      </div>
                    </motion.div>
                  )}
                  {/* Face-up ghost of a just-collected pair — the real card
                      left the grid in the same update that revealed it. */}
                  {isEmpty && ghostCard && (
                    <CollectedGhost card={ghostCard} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* collection flights */}
      {collectFx.map((fx, i) => (
        <CollectFlight key={fx.id} fx={fx} delay={i * 0.07} />
      ))}

      {/* round-over overlay */}
      {roundOver && <PairOneResults view={view} room={room} />}

      <ChatPanel room={room} floating />
    </div>
  );
}

/**
 * Face-up ghost of a card that was just collected: pulses gold in its old
 * slot and fades as the flying copy heads for the collector's chip. This is
 * how the second flipped card gets SEEN — the server removes it from the grid
 * in the same update that reveals it.
 */
function CollectedGhost({ card }: { card: Card }) {
  const red = card.suit === 'hearts' || card.suit === 'diamonds';
  return (
    <motion.div
      className="pcard po-card faceup collected"
      initial={{ opacity: 1, scale: 1 }}
      animate={{ scale: [1, 1.2, 1.08], opacity: [1, 1, 0] }}
      transition={{ duration: 0.8, ease: 'easeOut' }}
    >
      <div className="pcard-inner">
        <div className="pcard-face po-front">
          <span className={`po-corner tl ${red ? 'red' : ''}`}>{RANK_LABELS[card.rank]}</span>
          <span className={`po-rank ${red ? 'red' : ''}`}>
            {RANK_LABELS[card.rank]}
            <em>{SUIT_GLYPH[card.suit]}</em>
          </span>
          <span className={`po-corner br ${red ? 'red' : ''}`}>{RANK_LABELS[card.rank]}</span>
        </div>
      </div>
    </motion.div>
  );
}

/** A matched pair flying from its two grid slots into the collector's chip. */
function CollectFlight({ fx, delay }: { fx: CollectFx; delay: number }) {  const midX = (fx.fromA.x + fx.to.x) / 2;
  const midY = Math.min(fx.fromA.y, fx.to.y) - 70;
  const render = (pos: { x: number; y: number }, card: Card, key: string) => (
    <motion.div
      key={key}
      className="po-fly"
      initial={{ x: pos.x, y: pos.y, scale: 1, opacity: 1, rotate: 0 }}
      animate={{
        x: [pos.x, midX, fx.to.x],
        y: [pos.y, midY, fx.to.y],
        scale: [1, 1.18, 0.25],
        opacity: [1, 1, 0],
        rotate: [0, 10, -14],
      }}
      transition={{ duration: 0.9, delay, ease: 'easeInOut' }}
    >
      <span className={`po-fly-card ${card.suit === 'hearts' || card.suit === 'diamonds' ? 'red' : ''}`}>
        {RANK_LABELS[card.rank]}
        {SUIT_GLYPH[card.suit]}
      </span>
    </motion.div>
  );
  return (
    <>
      {render(fx.fromA, fx.cardA, `${fx.id}-a`)}
      {render(fx.fromB, fx.cardB, `${fx.id}-b`)}
    </>
  );
}

/** Bottom-right rules button — opens the Pair One rules modal. */
function InfoButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="info-toggle"
        onClick={() => setOpen(true)}
        aria-label="Rules"
        title="How to play Pair One"
      >
        ❓
      </button>
      <InfoModal open={open} onClose={() => setOpen(false)} game="pairone" />
    </>
  );
}

/** Round-end results: pairs collected, match totals, host actions. */
function PairOneResults({ view, room }: { view: PairOnePlayerView; room: RoomApi }) {
  const ranked = [...view.players].sort((a, b) => b.cardCount - a.cardCount);
  const best = ranked[0]?.cardCount ?? 0;
  const winners = ranked.filter((p) => p.cardCount === best);
  const matchScores = room.lobby?.scoreboard ?? {};
  const isHost = room.lobby?.hostId === room.myPlayerId;
  const fallbackAvatar = { color: 0, eyes: 0, mouth: 0, hat: 0 };
  const avatarOf = (pid: string) =>
    room.lobby?.players.find((p) => p.id === pid)?.avatar ?? fallbackAvatar;

  return (
    <motion.div initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} className="round-overlay">
      <div className="round-card">
        <h2 className="font-display round-title">All pairs found!</h2>
        {winners.length === 1 ? (
          <p className="round-winner">🏆 {winners[0]!.name} wins the round!</p>
        ) : (
          <p className="round-winner">🤝 Tie between {winners.map((p) => p.name).join(' & ')}</p>
        )}
        {Object.keys(matchScores).length > 0 && (
          <div className="match-scores">
            <span className="match-title">Match totals</span>
            {Object.entries(matchScores)
              .sort((a, b) => b[1] - a[1])
              .map(([id, total]) => (
                <span key={id} className="match-entry">
                  {view.players.find((p) => p.id === id)?.name ?? id} <strong>{total}</strong>
                </span>
              ))}
            <span className="match-hint">(most pairs leads)</span>
          </div>
        )}
        <table className="score-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Pairs</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((p, i) => (
              <motion.tr
                key={p.id}
                initial={{ opacity: 0, x: -14 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.15 + i * 0.16 }}
                className={p.cardCount === best ? 'winner-row' : ''}
              >
                <td className="po-result-player">
                  <Avatar avatar={avatarOf(p.id)} size={26} />
                  {p.name}
                </td>
                <td className="score-num">{p.cardCount}</td>
              </motion.tr>
            ))}
          </tbody>
        </table>
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
    </motion.div>
  );
}
