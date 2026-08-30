import { AnimatePresence, motion } from 'framer-motion';
import type { Card as CardModel } from '@shared/cards.js';
import { RANK_LABELS } from '@shared/cards.js';
import type { SeepPlayerView } from '@seep/views.js';
import type { SeepTeam } from '@seep/rules.js';
import Card from '../table/Card.js';

const SUIT_GLYPH: Record<string, string> = {
  spades: '♠',
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
};

function CardFace({ card }: { card: CardModel }) {
  const red = card.suit === 'hearts' || card.suit === 'diamonds';
  return (
    <span className={`seep-mini-face ${red ? 'red' : ''}`}>
      {RANK_LABELS[card.rank]}
      {SUIT_GLYPH[card.suit] ?? ''}
    </span>
  );
}

export interface SeepCenterProps {
  view: SeepPlayerView;
  myTeam: SeepTeam | null;
  /** Table cards in the currently picked capture/build set. */
  pickedTableIds: string[];
  /** Table cards that the selected card can CAPTURE — golden targets. */
  glowTakeIds: string[];
  /** Table cards the selected card can BUILD with — blue targets. */
  glowBuildIds: string[];
  /** Click action per house for the selected card. */
  houseActions: Record<string, 'take' | 'add' | 'break'>;
  /** House ids highlighted because the selected card interacts with them. */
  highlightHouseIds: string[];
  /** My hand card currently selected (drives highlights). */
  selectedCardId: string | null;
  onTableCardClick?: (cardId: string) => void;
  onHouseClick?: (houseId: string) => void;
}

/**
 * The Seep centre: team score rails, the stock pile, the loose table spread
 * and the face-up house stacks. Everything here is public information.
 */
export default function SeepCenter({
  view,
  myTeam,
  pickedTableIds,
  glowTakeIds,
  glowBuildIds,
  houseActions,
  highlightHouseIds,
  selectedCardId,
  onTableCardClick,
  onHouseClick,
}: SeepCenterProps) {
  const picked = new Set(pickedTableIds);
  const glowTake = new Set(glowTakeIds);
  const glowBuild = new Set(glowBuildIds);
  const highlighted = new Set(highlightHouseIds);
  const rails: Array<{ team: SeepTeam; label: string }> = [
    { team: 0, label: 'Team A' },
    { team: 1, label: 'Team B' },
  ];
  const houseBadge = { take: '🖐', add: '➕', break: '💥' } as const;

  return (
    <div className="seep-center">
      {/* team score rails */}
      <div className="seep-rails">
        {rails.map(({ team, label }) => {
          const mine = myTeam === team;
          return (
            <div key={team} className={`seep-rail team${team} ${mine ? 'mine' : ''}`}>
              <span className="seep-rail-name">
                {label}
                {mine ? ' (you)' : ''}
                <span className="seep-rail-scope">this deal</span>
              </span>
              <span className="seep-rail-points">{view.teamPoints[team]}</span>
              {view.sweeps[team] > 0 && (
                <span className="seep-rail-sweeps" title="Sweeps (+50 each)">
                  {'✨'.repeat(Math.min(view.sweeps[team], 3))}
                </span>
              )}
            </div>
          );
        })}
      </div>



      <div className="seep-middle">
        {/* stock pile (informational) */}
        <div className="pile deck-pile seep-deck">
          <div className="deck-stack s1" />
          <div className="deck-stack s2" />
          <div className="deck-stack s3" />
          <span className="pile-label">STOCK</span>
          <span className="pile-count">{view.deckCount}</span>
        </div>

        {/* stock pile (informational) */}
        <div className="pile deck-pile seep-deck">
          <div className="deck-stack s1" />
          <div className="deck-stack s2" />
          <div className="deck-stack s3" />
          <span className="pile-label">STOCK</span>
          <span className="pile-count">{view.deckCount}</span>
        </div>

        {/* last-pickup inspection tray: public while the next player hasn't played */}
        {view.inspectableCardIds.length > 0 && (
          <div className="seep-inspect" title="Last pick-up — inspectable until the next play">
            <span className="seep-inspect-label">last pick-up</span>
            {view.inspectableCardIds.map((id) => {
              const card = view.knownCards[id];
              return card ? <Card key={id} cardId={id} card={card} small /> : null;
            })}
          </div>
        )}

        {/* loose table spread (face-down until the opener announces) */}
        <div className="seep-spread" aria-label="Cards on the table">
          <AnimatePresence>
            {view.tableLoose.map((card, i) => {
              const take = glowTake.has(card.id);
              const build = !take && glowBuild.has(card.id);
              return (
                <motion.div
                  key={card.id}
                  initial={{ scale: 0.4, opacity: 0, rotate: 0 }}
                  animate={{ scale: 1, opacity: 1, rotate: (i % 3) - 1 }}
                  exit={{ scale: 0.5, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 320, damping: 26 }}
                  className={`seep-spread-slot ${take ? 'glow-take' : ''} ${build ? 'glow-build' : ''}`}
                >
                  <Card
                    cardId={card.id}
                    card={card}
                    small
                    selectable={!!onTableCardClick && (take || build || picked.has(card.id))}
                    highlight={picked.has(card.id)}
                    onClick={onTableCardClick ? () => onTableCardClick(card.id) : undefined}
                  />
                </motion.div>
              );
            })}
          </AnimatePresence>
          {view.tableLoose.length === 0 && view.tableFaceDownCount > 0 && (
            <>
              {Array.from({ length: view.tableFaceDownCount }, (_, i) => (
                <Card key={`back-${i}`} cardId={`back-${i}`} card={null} faceDown small />
              ))}
              <span className="seep-spread-empty">waiting for the announce…</span>
            </>
          )}
          {view.tableLoose.length === 0 && view.tableFaceDownCount === 0 && (
            <div className="seep-spread-empty">table cleared — next player lays down</div>
          )}
        </div>

        {/* house stacks */}
        <div className="seep-houses">
          <AnimatePresence>
            {view.houses.map((house) => {
              const top = house.cards[house.cards.length - 1];
              const action = houseActions[house.id];
              const ownerTeams = Object.keys(house.ownerByTeam).map(Number);
              const teamClass = ownerTeams.length === 2 ? 'both' : `team${ownerTeams[0] ?? 0}`;
              const ownerNames = house.owners.map((o) => view.players.find((p) => p.id === o)?.name ?? o).join(' & ');
              return (
                <motion.button
                  key={house.id}
                  className={`seep-house ${teamClass} ${highlighted.has(house.id) ? 'hot' : ''} ${action ? `act-${action}` : ''}`}
                  data-card-id={house.id}
                  initial={{ scale: 0.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.5, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 24 }}
                  onClick={onHouseClick ? () => onHouseClick(house.id) : undefined}
                  disabled={!onHouseClick}
                  title={`Ghar ${house.total} — ${house.pakka ? `pakka (locked, ${house.copies} sets)` : 'kachcha (breakable)'}, owned by ${ownerNames}, ${house.cards.length} cards`}
                >
                  {action && (
                    <span className={`seep-house-badge ${action}`} aria-hidden>
                      {houseBadge[action]}
                    </span>
                  )}
                  <span className="seep-house-total">
                    {house.total}
                    {house.pakka && (
                      <span className="seep-house-pakka" title="Pakka ghar — cannot be broken">
                        🔒
                      </span>
                    )}
                  </span>
                  <span className="seep-house-stack" aria-hidden>
                    {house.cards.slice(0, 3).map((c, i) => (
                      <span key={c.id} className="seep-house-card" style={{ top: -i * 3 }}>
                        {top ? <CardFace card={c} /> : null}
                      </span>
                    ))}
                  </span>
                  <span className="seep-house-count">{house.cards.length}</span>
                </motion.button>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
