import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

const EMOTE_TTL_MS = 2400;

/** A reaction floating up from a player's seat, then fading. */
export default function FloatingEmote({
  emote,
}: {
  emote?: { emote: string; at: number };
}) {
  const [, setTick] = useState(0);
  const visible = !!emote && Date.now() - emote.at < EMOTE_TTL_MS;

  // Self-remove once the TTL passes, even if nothing else re-renders.
  useEffect(() => {
    if (!emote) return;
    const remaining = EMOTE_TTL_MS - (Date.now() - emote.at);
    if (remaining <= 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), remaining + 30);
    return () => clearTimeout(t);
  }, [emote]);

  return (
    <div className="floating-emote" aria-live="polite">
      <AnimatePresence>
        {visible && (
          <motion.span
            key={emote!.at}
            initial={{ y: 10, scale: 0.4, opacity: 0 }}
            animate={{ y: -46, scale: 1.25, opacity: 1 }}
            exit={{ y: -70, scale: 1, opacity: 0 }}
            transition={{ duration: 1.4, ease: 'easeOut' }}
          >
            {emote!.emote}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
