/**
 * ICE server list for the voice/video mesh, served at runtime so a TURN relay
 * can be added through environment variables without rebuilding the client.
 *
 * - ICE_SERVERS: a JSON array of RTCIceServer dicts, used as is.
 * - TURN_URLS + TURN_SECRET: a coturn relay using its REST-API shared secret
 *   (`use-auth-secret`). Each request gets credentials valid for 12 hours.
 * STUN is always included first.
 */
import { createHmac } from 'node:crypto';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const STUN: IceServer = { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] };

export function iceServers(env: NodeJS.ProcessEnv = process.env, now = Date.now()): IceServer[] {
  const out: IceServer[] = [STUN];
  if (env.ICE_SERVERS) {
    try {
      const parsed: unknown = JSON.parse(env.ICE_SERVERS);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && typeof entry === 'object' && 'urls' in entry) out.push(entry as IceServer);
        }
      }
    } catch {
      /* malformed: keep STUN only */
    }
  }
  const urls = (env.TURN_URLS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  if (urls.length > 0 && env.TURN_SECRET) {
    const username = `${Math.floor(now / 1000) + 12 * 3600}:gamenight`;
    const credential = createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    out.push({ urls, username, credential });
  }
  return out;
}
