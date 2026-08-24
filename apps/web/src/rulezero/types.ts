/**
 * Types mirroring rulezero/service.py `game-service/v1` view payloads.
 * The browser renders EXACTLY what the service emits — hidden zones arrive
 * as counts only, so the client cannot leak what it never received.
 */

export interface ServiceCandidate {
  candidateId: string;
  environmentActionId: number;
  label: string;
}

export interface ServiceZone {
  id: string;
  visibility: 'hidden' | 'owner' | 'public';
  owner: number | null;
  cards?: number[];
  count?: number;
}

export interface ServiceView {
  protocol: string;
  specHash: string;
  player: number;
  phase?: string;
  observation: string;
  informationState: string;
  isTerminal: boolean;
  currentActor: number | null;
  candidates: ServiceCandidate[];
  zones: ServiceZone[];
  scores?: Record<string, number>;
}
