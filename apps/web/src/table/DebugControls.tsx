import { useEffect, useMemo, useState } from 'react';
import type { AiAttemptTrace, AiDecisionTrace, TokenUsage } from '../server-protocol.js';
import type { RoomApi } from '../useRoom.js';

/** Host-only controls for inspecting live AI decisions without exposing CoT. */
export default function DebugControls({ room, initiallyOpen = false }: { room: RoomApi; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [selectedPlayer, setSelectedPlayer] = useState('all');
  const isHost = room.lobby?.hostId === room.myPlayerId;
  const traces = room.lobby?.aiThoughts ?? [];
  const aiPlayers = useMemo(
    () => room.lobby?.players.filter((player) => player.kind === 'ai') ?? [],
    [room.lobby?.players],
  );
  const visible = traces.filter((trace) => selectedPlayer === 'all' || trace.playerId === selectedPlayer);
  const hasAi = aiPlayers.length > 0;
  if (!isHost) return null;

  return (
    <>
      <button
        className={`debug-toggle ${room.testMode || room.lobby?.aiDebug ? 'on' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Open AI trace and test controls"
        title="AI trace and test controls"
      >
        AI DEBUG
      </button>
      {open && (
        <aside className="debug-menu" role="dialog" aria-label="Debug controls">
          <div className="debug-menu-head">
            <div>
              <strong>AI decision inspector</strong>
              <small>Host only · concise explanations and provider telemetry</small>
            </div>
            <button className="debug-menu-close" onClick={() => setOpen(false)} aria-label="Close debug controls">×</button>
          </div>
          <label className="debug-option">
            <input type="checkbox" checked={room.testMode} onChange={(event) => room.setTestMode(event.target.checked)} />
            <span><strong>Reveal every card</strong><small>Test Mode also permits filtered model inputs in the inspector.</small></span>
          </label>
          <label className="debug-option">
            <input type="checkbox" checked={!!room.lobby?.aiDebug} onChange={(event) => room.setAiDebug(event.target.checked)} />
            <span><strong>Show AI trace</strong><small>Shows model summaries, attempts, token counts, and authoritative actions. Hidden reasoning text is never shown.</small></span>
          </label>
          <div className="debug-trace-toolbar">
            <div className="debug-trace-head"><span>Decision timeline</span><span>{visible.length} records</span></div>
            {hasAi && (
              <label className="debug-filter">
                <span>Follow</span>
                <select aria-label="Filter AI decisions" value={selectedPlayer} onChange={(event) => setSelectedPlayer(event.target.value)}>
                  <option value="all">All AI seats</option>
                  {aiPlayers.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
                </select>
              </label>
            )}
          </div>
          {!hasAi && <p className="debug-empty">Add an AI seat to inspect its decisions.</p>}
          {hasAi && !room.lobby?.aiDebug && <p className="debug-empty">Turn on AI trace, then start or continue the table.</p>}
          {hasAi && room.lobby?.aiDebug && visible.length === 0 && <p className="debug-empty">Listening for the next AI decision…</p>}
          {room.lobby?.aiDebug && visible.length > 0 && (
            <ol className="debug-traces" aria-live="polite">
              {visible.slice().reverse().map((trace) => <Trace key={trace.id} trace={trace} />)}
            </ol>
          )}
        </aside>
      )}
    </>
  );
}

function Trace({ trace }: { trace: AiDecisionTrace }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (trace.status !== 'thinking') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [trace.status]);
  const statusLabel = trace.status === 'thinking' ? 'deciding…' : trace.status;
  const elapsedMs = trace.status === 'thinking'
    ? Math.max(0, now - Date.parse(trace.startedAt))
    : undefined;
  return (
    <li className={`debug-trace ${trace.status}`} data-trace-id={trace.id}>
      <div className="debug-trace-top">
        <strong>{trace.playerName} <span className="debug-sequence">#{trace.sequence}</span></strong>
        <span>{statusLabel}{elapsedMs != null ? ` · ${formatElapsed(elapsedMs)}` : ''}</span>
      </div>
      <small className="debug-trace-source">{trace.source}</small>
      <p>{trace.summary ?? (trace.status === 'thinking' ? 'Reviewing the filtered table…' : 'No model summary was provided.')}</p>
      <div className="debug-action-row">
        <span>Proposed <code>{trace.proposedAction ?? 'none'}</code></span>
        <span>Executed <code>{trace.executedAction ?? 'pending'}</code></span>
        <span>Source <code>{trace.decisionSource ?? 'pending'}</code></span>
      </div>
      {trace.rationale && trace.rationale.length > 0 && (
        <details className="debug-rationale" open={trace.status === 'decision'}>
          <summary>Decision factors</summary>
          <ol>{trace.rationale.map((factor, index) => <li key={`${trace.id}-factor-${index}`}>{factor}</li>)}</ol>
        </details>
      )}
      <UsageGrid usage={trace.usage} latencyMs={trace.latencyMs} finishReason={trace.finishReason} attempts={trace.attempts.length} />
      {trace.failure && <small className="debug-failure">Failure: {trace.failure}</small>}
      {trace.providerReasoningAvailable && <small className="debug-private-note">Provider reasoning field received; its text is intentionally omitted.</small>}
      {trace.attempts.length > 0 && (
        <details className="debug-attempts">
          <summary>Request attempts ({trace.attempts.length})</summary>
          <ol>
            {trace.attempts.map((attempt) => <Attempt key={`${trace.id}-${attempt.attempt}`} attempt={attempt} />)}
          </ol>
        </details>
      )}
      {(trace.candidates || trace.observation) && (
        <details className="debug-detail">
          <summary>Filtered model input</summary>
          {trace.candidates && <pre>{trace.candidates.join('\n')}</pre>}
          {trace.observation && <pre>{trace.observation}</pre>}
        </details>
      )}
    </li>
  );
}

function Attempt({ attempt }: { attempt: AiAttemptTrace }) {
  return (
    <li className="debug-attempt">
      <div><strong>Attempt {attempt.attempt}</strong><span className={attempt.status === 'accepted' ? 'debug-ok' : 'debug-bad'}>{attempt.status}</span></div>
      <UsageGrid usage={attempt.usage} latencyMs={attempt.latencyMs} finishReason={attempt.finishReason} />
      {attempt.httpStatus != null && <small>HTTP {attempt.httpStatus}</small>}
      {attempt.failure && <small>{attempt.failure}</small>}
      {attempt.reasoningAvailable && <small>Provider reasoning field received</small>}
    </li>
  );
}

function UsageGrid({ usage, latencyMs, finishReason, attempts }: { usage?: TokenUsage; latencyMs?: number; finishReason?: string; attempts?: number }) {
  return (
    <div className="debug-token-grid">
      <span>Prompt <strong>{token(usage?.promptTokens)}</strong></span>
      <span>Completion <strong>{token(usage?.completionTokens)}</strong></span>
      <span>Reasoning <strong>{token(usage?.reasoningTokens)}</strong></span>
      <span>Total <strong>{token(usage?.totalTokens)}</strong></span>
      {latencyMs != null && <span>Latency <strong>{latencyMs}ms</strong></span>}
      {finishReason && <span>Finish <strong>{finishReason}</strong></span>}
      {attempts != null && <span>Attempts <strong>{attempts}</strong></span>}
    </div>
  );
}

function token(value: number | undefined): string {
  return value == null ? 'not reported' : value.toLocaleString();
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return '<1s';
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
