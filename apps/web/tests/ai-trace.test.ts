import { describe, expect, it } from 'vitest';
import type { AiDecisionTrace } from '../src/server-protocol.js';
import { mergeAiTraces, upsertAiTrace } from '../src/table/ai-trace.js';

function trace(version: number, status: AiDecisionTrace['status'] = 'thinking'): AiDecisionTrace {
  return {
    id: 'decision-1',
    version,
    sequence: 1,
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: `2026-01-01T00:00:0${version}.000Z`,
    playerId: 'ai-1',
    playerName: 'AI',
    source: 'LLM · test',
    attempts: [],
  };
}

describe('AI trace merging', () => {
  it('upserts lifecycle updates instead of appending duplicate cards', () => {
    const first = upsertAiTrace([], trace(1));
    const final = upsertAiTrace(first, trace(2, 'executed'));
    expect(final).toHaveLength(1);
    expect(final[0]?.status).toBe('executed');
    expect(final[0]?.version).toBe(2);
  });

  it('ignores an older snapshot after a newer live update', () => {
    const newer = upsertAiTrace([], trace(3, 'executed'));
    const merged = mergeAiTraces(newer, [trace(1), trace(2, 'decision')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.version).toBe(3);
    expect(merged[0]?.status).toBe('executed');
  });
});
