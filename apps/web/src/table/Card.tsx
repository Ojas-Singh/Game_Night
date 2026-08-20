import { motion } from 'framer-motion';
import type { Card as CardModel } from '@shared/cards.js';
import { RANK_LABELS } from '@shared/cards.js';

const SUIT_GLYPH: Record<string, string> = {
  spades: '♠',
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
};

export interface CardProps {
  cardId: string;
  card: CardModel | null;
  faceDown?: boolean;
  /** Small dot: value remembered but currently face-down. */
  seenMarker?: boolean;
  small?: boolean;
  drawn?: boolean;
  highlight?: boolean;
  dimmed?: boolean;
  lifted?: boolean;
  selectable?: boolean;
  onClick?: () => void;
}

/**
 * A physical-feeling card: 3D flip via backface transforms, hover lift,
 * selection glow. Value is rendered ONLY when the server says we know it.
 */
export default function Card({
  cardId,
  card,
  faceDown = false,
  seenMarker = false,
  small = false,
  drawn = false,
  highlight = false,
  dimmed = false,
  lifted = false,
  selectable = false,
  onClick,
}: CardProps) {
  const red = card && (card.suit === 'hearts' || card.suit === 'diamonds');
  const interactive = !!onClick;

  return (
    <motion.button
      layout
      layoutId={cardId}
      initial={{ scale: 0.75, opacity: 0, y: drawn ? -110 : -26 }}
      animate={{ scale: 1, opacity: dimmed ? 0.55 : 1, y: 0 }}
      exit={{ scale: 0.6, opacity: 0, y: -30 }}
      transition={{ type: 'spring', stiffness: 330, damping: 26, mass: 0.9 }}
      className={`pcard ${small ? 'small' : ''} ${faceDown ? 'facedown' : 'faceup'} ${
        highlight ? 'highlight' : ''
      } ${dimmed ? 'dimmed' : ''} ${lifted ? 'lifted' : ''} ${selectable ? 'selectable' : ''} ${
        drawn ? 'drawn' : ''
      } ${interactive ? 'clickable' : ''} ${seenMarker ? 'seen' : ''}`}
      onClick={onClick}
      disabled={!interactive}
      aria-label={faceDown ? (card ? `face-down card (you saw this one)` : 'face-down card') : card ? `${RANK_LABELS[card.rank]} of ${card.suit}` : 'card'}
      data-card-id={cardId}
    >
      <div className="pcard-inner">
        <div className="pcard-face pcard-front">
          {card ? (
            <>
              <span className={`corner tl ${red ? 'red' : ''}`}>{RANK_LABELS[card.rank]}</span>
              <span className={`pip ${red ? 'red' : ''}`}>{SUIT_GLYPH[card.suit] ?? ''}</span>
              <span className={`corner br ${red ? 'red' : ''}`}>{RANK_LABELS[card.rank]}</span>
            </>
          ) : (
            <span className="unknown">?</span>
          )}
        </div>
        <div className="pcard-face pcard-back">
          <div className="back-pattern" />
        </div>
      </div>
    </motion.button>
  );
}
