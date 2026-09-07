import { createAgentRng, type AgentObservation, type GameAgent } from '@game-night/agent-core';
import { CaboHeuristicBot } from '@game-night/agent-bots';
import { LlmAgent } from '@game-night/agent-llm';
import { Room } from './room.js';

export interface CaboDiagnosticConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  provider?: string;
  timeoutMs: number;
  maxTokens: number;
  scenarios?: number;
  maxDecisions?: number;
}

export interface CaboDiagnosticResult {
  configured: boolean;
  model: string;
  provider?: string;
  scenarios: number;
  decisions: number;
  modelAccepted: number;
  fallbacks: number;
  failures: Array<{ kind: string; message: string }>;
  samples: Array<{ seed: number; decisions: number; finished: boolean; failures: number }>;
}

/**
 * Run a bounded provider probe against the same Room/Cabo authority path used
 * by live seats. The response deliberately contains aggregate metadata only;
 * prompts, hands, credentials, and provider response bodies stay server-side.
 */
export async function runCaboDiagnostic(config: CaboDiagnosticConfig): Promise<CaboDiagnosticResult> {
  const scenarios = Math.max(1, Math.min(config.scenarios ?? 5, 24));
  const maxDecisions = Math.max(8, Math.min(config.maxDecisions ?? 80, 160));
  const failures: Array<{ kind: string; message: string }> = [];
  const samples: CaboDiagnosticResult['samples'] = [];
  let decisions = 0;
  let modelAccepted = 0;
  let fallbacks = 0;

  for (let scenario = 0; scenario < scenarios; scenario += 1) {
    const room = new Room({ roomId: `DIAG${scenario}` , debug: { seed: 41_000 + scenario } });
    const first = room.addPlayer('Probe model').player;
    const second = room.addPlayer('Probe opponent').player;
    room.startGame(first.id);
    const model = new LlmAgent({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      provider: config.provider,
      timeoutMs: config.timeoutMs,
      maxTokens: config.maxTokens,
      mode: 'research-strict',
      idSuffix: `:diagnostic-${scenario}`,
      sessionId: config.provider === 'opencode-go' ? `diagnostic-cabo-${scenario}` : undefined,
    });
    const opponent = new CaboHeuristicBot({ idSuffix: `:diagnostic-${scenario}` });
    const agents: Record<string, GameAgent> = { [first.id]: model, [second.id]: opponent };
    let localDecisions = 0;
    let localFailures = 0;
    while (room.engine && !room.engine.isGameFinished() && localDecisions < maxDecisions) {
      const state = room.engine.getState() as { phase: string; players: Array<{ id: string }>; currentTurn: number; initialPeeksRemaining?: string[] };
      let actor = state.players[state.currentTurn]?.id;
      if (state.phase === 'INITIAL_PEEK') actor = state.initialPeeksRemaining?.[0];
      if (!actor) break;
      const view = room.gameView(actor, { forAi: true });
      if (!view || view.gameId !== 'cabo') break;
      const obs: AgentObservation = { gameId: 'cabo', selfId: actor, view, step: localDecisions };
      try {
        const decision = await agents[actor]!.decide(obs, { rng: createAgentRng(9_000 + scenario * 100 + localDecisions) });
        room.handleGameAction(actor, decision.action);
        decisions += 1;
        localDecisions += 1;
        if (decision.meta?.source === 'model') modelAccepted += 1;
      } catch (err) {
        localFailures += 1;
        failures.push({ kind: err instanceof Error && err.message.includes('strict violation') ? 'model_failure' : 'authority_failure', message: String(err).slice(0, 180) });
        // Strict probes never substitute a move. The scenario ends so a
        // provider failure cannot be mistaken for successful play.
        break;
      }
    }
    samples.push({ seed: 41_000 + scenario, decisions: localDecisions, finished: !!room.engine?.isGameFinished(), failures: localFailures });
    room.dispose();
  }
  return { configured: Boolean(config.baseUrl && config.model), model: config.model, provider: config.provider, scenarios, decisions, modelAccepted, fallbacks, failures: failures.slice(0, 24), samples };
}
