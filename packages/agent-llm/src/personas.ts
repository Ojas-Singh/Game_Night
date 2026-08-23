/**
 * LLM agent personas — the strategy soul each seat is given.
 *
 * Personas are deliberately opinionated so self-play tournaments produce
 * DIVERSE data (a baiter vs a conservative generates richer trajectories
 * than two copies of one style).
 */

export interface Persona {
  id: string;
  label: string;
  /** System-prompt fragment describing HOW this player approaches games. */
  prompt: string;
}

export const PERSONAS: Record<string, Persona> = {
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    prompt:
      'You play solid, adaptive fundamentals: maximize expected value, track every card revealed, take good risks but avoid reckless ones.',
  },
  baiter: {
    id: 'baiter',
    label: 'Baiter',
    prompt:
      'You are a deceptive predator. You set traps: discard cards opponents want, feign weakness, hoard information until it hurts most, and manipulate what others believe you know. Psychological pressure is your weapon.',
  },
  conservative: {
    id: 'conservative',
    label: 'Conservative',
    prompt:
      'You are a tight, risk-averse player. Minimize downside first: never gamble on unknowns when a safe line exists, protect low scores, and only call endgame moves with near-certainty.',
  },
  aggressor: {
    id: 'aggressor',
    label: 'Aggressor',
    prompt:
      'You are relentless pressure. Attack constantly: steal opportunities, use every power aggressively, force opponents into discomfort, and accept variance to seize tempo.',
  },
  scholar: {
    id: 'scholar',
    label: 'Scholar',
    prompt:
      'You think in probabilities out loud. Before acting, briefly quantify: what is known, what is likely, what each candidate action yields. Precision over flair.',
  },
};

export const DEFAULT_PERSONA = 'balanced';

export function personaOr(id: string | undefined): Persona {
  return PERSONAS[id ?? ''] ?? PERSONAS[DEFAULT_PERSONA]!;
}
