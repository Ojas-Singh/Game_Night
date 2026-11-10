/** The server's lab API (/api/lab). */
import type { LabRunRequest, LabRunStatus } from '@shared/lab.js';
import type { LabGame } from './format.js';

export interface LabInfo {
  games: LabGame[];
  /** Games the server's trained player plays; empty when none is loaded. */
  modelGames: string[];
  modelSamples: number;
  limits: { rounds: number; variants: number };
}

const KEY = 'gn.labKey';

export function labKey(): string {
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}

export function setLabKey(key: string): void {
  try { localStorage.setItem(KEY, key); } catch { /* the key lasts for this visit only */ }
}

/** Thrown with the HTTP status when the lab refuses a request. */
export class LabError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/lab${path}`, {
    ...init,
    cache: 'no-store',
    headers: { 'content-type': 'application/json', 'x-lab-key': labKey() },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new LabError(body.error ?? `the lab answered ${res.status}`, res.status);
  return body as T;
}

export const labApi = {
  info: () => call<LabInfo>(''),
  start: (request: LabRunRequest) => call<{ id: string }>('/runs', { method: 'POST', body: JSON.stringify(request) }),
  status: (id: string) => call<LabRunStatus>(`/runs/${id}`),
  cancel: (id: string) => call<{ ok: boolean }>(`/runs/${id}`, { method: 'DELETE' }),
};
