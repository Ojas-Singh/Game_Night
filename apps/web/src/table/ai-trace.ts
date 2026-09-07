import type { AiDecisionTrace } from '../server-protocol.js';

/** Merge a live trace update without duplicating lifecycle events. */
export function upsertAiTrace(
  current: AiDecisionTrace[],
  incoming: AiDecisionTrace,
  limit = 80,
): AiDecisionTrace[] {
  const index = current.findIndex((trace) => trace.id === incoming.id);
  if (index >= 0 && current[index]!.version > incoming.version) return current;
  const next = current.slice();
  if (index >= 0) next[index] = incoming;
  else next.push(incoming);
  next.sort((a, b) => a.sequence - b.sequence || a.startedAt.localeCompare(b.startedAt));
  return next.slice(-limit);
}

/** Hydrate a snapshot or a batch of updates with the same version rules. */
export function mergeAiTraces(
  current: AiDecisionTrace[],
  incoming: AiDecisionTrace[] | undefined,
  limit = 80,
): AiDecisionTrace[] {
  return (incoming ?? []).reduce((traces, trace) => upsertAiTrace(traces, trace, limit), current);
}
