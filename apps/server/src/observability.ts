/**
 * Optional server-side Sentry wiring. A no-op until SENTRY_DSN is configured;
 * the SDK loads via dynamic import so it never affects startup when unused.
 */

export interface Observability {
  capture: (err: unknown, context?: Record<string, unknown>) => void;
  readonly enabled: boolean;
}

const noop: Observability = { capture: () => undefined, enabled: false };

let obs: Observability = noop;

export async function initServerObservability(dsn: string | undefined, env: string): Promise<Observability> {
  if (!dsn) return noop;
  try {
    const Sentry = await import('@sentry/node');
    Sentry.init({ dsn, environment: env, tracesSampleRate: 0.1 });
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

export function captureServer(err: unknown, context?: Record<string, unknown>): void {
  obs.capture(err, context);
}
