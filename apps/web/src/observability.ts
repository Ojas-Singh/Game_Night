/**
 * Optional web-side Sentry wiring. A no-op until VITE_SENTRY_DSN is set at
 * build time; the SDK loads via dynamic import (own chunk) when configured.
 */

export interface Observability {
  capture: (err: unknown, context?: Record<string, unknown>) => void;
  readonly enabled: boolean;
}

const noop: Observability = { capture: () => undefined, enabled: false };

let obs: Observability = noop;

export async function initWebObservability(): Promise<Observability> {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return noop;
  try {
    const Sentry = await import('@sentry/react');
    Sentry.init({ dsn, tracesSampleRate: 0.1 });
    obs = {
      enabled: true,
      capture: (err, context) => {
        Sentry.captureException(err, { extra: context });
      },
    };
  } catch {
    /* SDK missing — stay silent */
  }
  return obs;
}

export function captureWeb(err: unknown, context?: Record<string, unknown>): void {
  obs.capture(err, context);
}
