import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DebugControls from '../src/table/DebugControls.js';
import type { RoomApi } from '../src/useRoom.js';
import type { AiDecisionTrace } from '../src/server-protocol.js';

const trace: AiDecisionTrace = {
  id: 'decision-1',
  version: 3,
  sequence: 7,
  status: 'executed',
  startedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.250Z',
  playerId: 'ai-1',
  playerName: 'AI Scholar',
  source: 'LLM · test-provider · test-model',
  model: 'test-model',
  summary: 'Keep the known low card.',
  rationale: ['low visible value', 'no safer flush'],
  proposedAction: 'DISCARD_DRAWN',
  executedAction: 'DISCARD_DRAWN',
  decisionSource: 'model',
  attempts: [{
    attempt: 1,
    status: 'accepted',
    latencyMs: 1_250,
    httpStatus: 200,
    finishReason: 'stop',
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    reasoningAvailable: true,
  }],
  usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  providerReasoningAvailable: true,
};

function room(): RoomApi {
  return {
    myPlayerId: 'host',
    lobby: {
      roomId: 'ROOM01',
      gameId: 'cabo',
      hostId: 'host',
      inGame: true,
      players: [
        { id: 'host', name: 'Host', avatar: { color: 0, eyes: 0, mouth: 0, hat: 0 }, isHost: true, ready: true, connected: true, kind: 'human', isYou: true },
        { id: 'ai-1', name: 'AI Scholar', avatar: { color: 1, eyes: 1, mouth: 1, hat: 1 }, isHost: false, ready: true, connected: true, kind: 'ai', isYou: false },
      ],
      scoreboard: {},
      testMode: false,
      aiDebug: true,
      aiThoughts: [trace],
    },
    testMode: false,
    setTestMode: () => undefined,
    setAiDebug: () => undefined,
  } as unknown as RoomApi;
}

describe('AI decision inspector', () => {
  it('renders one trace card with telemetry and omits provider reasoning text', () => {
    const markup = renderToStaticMarkup(<DebugControls room={room()} initiallyOpen />);
    expect(markup).toContain('AI decision inspector');
    expect(markup).toContain('DISCARD_DRAWN');
    expect(markup).toContain('Prompt');
    expect(markup).toContain('100');
    expect(markup).toContain('not reported');
    expect(markup).toContain('Request attempts (1)');
    expect(markup).toContain('Provider reasoning field received');
    expect(markup).not.toContain('hidden provider text');
    expect(markup.match(/data-trace-id=/g)).toHaveLength(1);
  });
});
