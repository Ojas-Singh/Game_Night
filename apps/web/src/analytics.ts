/**
 * Privacy-friendly funnel analytics — self-hosted Umami only, no cookies, no
 * third parties, no personal data. Enabled at build time via VITE_UMAMI_SRC +
 * VITE_UMAMI_WEBSITE_ID; without them every call is a deliberate no-op, so
 * self-hosted and development installs track nothing.
 *
 * Event payloads are strictly bounded enums (game ids, sku ids) — never player
 * names, room codes, chat text, or free-form strings.
 */

type Env = Record<string, string | undefined>;

/** Read lazily so runtime environments can differ from build time. */
function envValue(name: string): string | undefined {
  const env: Env = (import.meta as unknown as { env?: Env }).env ?? {};
  return env[name];
}

export interface AnalyticsConfig {
  /** Full URL of the Umami analytics script. */
  src: string;
  /** Umami website id. */
  websiteId: string;
}

/**
 * Config override — `undefined` reads the build-time environment, `null`
 * disables analytics outright (used by tests and could be used by a
 * "do not track" setting).
 */
let override: Partial<AnalyticsConfig> | null | undefined;

/**
 * Force or disable the analytics destination. Without arguments the module
 * returns to reading VITE_UMAMI_SRC / VITE_UMAMI_WEBSITE_ID.
 */
export function configureAnalytics(value?: Partial<AnalyticsConfig> | null): void {
  override = value;
}

function config(): AnalyticsConfig | null {
  const src = override?.src ?? envValue('VITE_UMAMI_SRC');
  const websiteId = override?.websiteId ?? envValue('VITE_UMAMI_WEBSITE_ID');
  return src && websiteId ? { src, websiteId } : null;
}

declare global {
  interface Window {
    umami?: { track?: (event?: string, data?: Record<string, string | number | boolean>) => void };
  }
}

let scriptInjected = false;

function ensureScript(src: string, websiteId: string): void {
  if (scriptInjected || typeof window === 'undefined' || typeof document === 'undefined') return;
  scriptInjected = true;
  if (document.querySelector(`script[src="${src}"]`)) return;
  const script = document.createElement('script');
  script.defer = true;
  script.src = src;
  script.setAttribute('data-website-id', websiteId);
  document.head.appendChild(script);
}

/** Fire-and-forget custom event; analytics must never break play. */
export function track(event: string, data?: Record<string, string | number | boolean>): void {
  const cfg = config();
  if (!cfg) return;
  ensureScript(cfg.src, cfg.websiteId);
  if (typeof window === 'undefined') return;
  try {
    window.umami?.track?.(event, data);
  } catch {
    /* ignore */
  }
}

/** The launch funnel (see docs/LAUNCH_CHECKLIST.md §Observability). */
export const funnel = {
  homeView: (): void => track('home_view'),
  roomCreated: (): void => track('room_create'),
  inviteAccepted: (): void => track('invite_join'),
  gameStarted: (gameId: string): void => track('game_start', { gameId }),
  voiceJoined: (): void => track('voice_join'),
  cameraEnabled: (): void => track('cam_on'),
  shopOpened: (): void => track('shop_open'),
  purchaseCompleted: (sku: string): void => track('purchase_complete', { sku }),
};
