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
  /** Counter-rotation (deg) so the value stays upright when the whole hand
   *  is rotated to face the player who sits there. */
  contentRotate?: number;
  onClick?: () => void;
}

/**
 * A card. Square, so it can be oriented toward a player with the value always
 * upright. Light, localized animations only — cards never reposition the
 * whole layout. Value is rendered only when the server says we know it.
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
  contentRotate = 0,
  onClick,
}: CardProps) {
  const red = card && (card.suit === 'hearts' || card.suit === 'diamonds');
  const interactive = !!onClick;
  const valueStyle = contentRotate ? { transform: `rotate(${contentRotate}deg)` } : undefined;

  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.7 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
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
            <div className={`card-label ${red ? 'red' : ''}`} style={valueStyle}>
              {RANK_LABELS[card.rank]}
              {SUIT_GLYPH[card.suit] ?? ''}
            </div>
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
