import { useEffect, useState } from 'react';
import { labApi } from './api.js';

type Job = {
  id: string; status: string; error?: string; rulesSummary?: string;
  report?: { ambiguities: string[]; assumptions: string[]; unsupported_mechanics: string[] };
  validation?: { episodes: number; reached_terminal: number; exhaustive: boolean };
};

const EXAMPLE_RULES = `High Card Duel

Two players play a short, competitive card game with a standard deck containing
one copy of ranks 1 through 10. Deal five cards face down to each player and
place the rest in a public draw pile. Players take turns, starting with player
1. On your turn, draw the top card, then choose exactly one card from your hand
to reveal and score. Discard the scored card face up. After both players have
completed five turns, the player with the higher total score wins. If the totals
are tied, split the win evenly. A player may never see an opponent's unrevealed
cards. The game ends immediately after the second player's fifth turn.`;

export default function CompileFlow({ onLaunch }: { onLaunch: (shareId: string, ai: boolean) => Promise<void> }) {
  const [text, setText] = useState(EXAMPLE_RULES);
  const [job, setJob] = useState<Job | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shareId, setShareId] = useState('');
  const pending = job && ['queued', 'drafting', 'validating', 'running'].includes(job.status);

  useEffect(() => {
    if (!pending || !job) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      labApi<{ job: Job }>('/jobs/' + job.id).then(r => { if (!stopped) setJob(r.job); })
        .catch(e => { if (!stopped) setError(e.message); });
    }, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [job?.id, pending]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function submit(revise = false) {
    setAcknowledged(false); setShareId('');
    const r = await labApi<{ job: Job }>(revise && job ? `/compile/jobs/${job.id}/revise` : '/compile/jobs', { text, answers });
    setJob(r.job);
  }
  async function share() {
    if (shareId) return shareId;
    const r = await labApi<{ shareId: string }>('/shared', { compileJobId: job?.id });
    setShareId(r.shareId);
    return r.shareId;
  }
  function loadExample() {
    setText(EXAMPLE_RULES);
    setJob(null);
    setAnswers({});
    setShareId('');
    setError('');
  }
  return <section className="lab-create" aria-labelledby="create-title">
    <div><p className="eyebrow">FROM YOUR IMAGINATION TO THE TABLE</p><h2 id="create-title">Make a game of it.</h2>
      <p className="muted">Describe a sequential card game. Review its rules, answer any questions, then invite your friends.</p></div>
    <div className="lab-rules-label"><label htmlFor="rules">Your game rules</label><span>Try the example below, or replace it with your own idea.</span><button type="button" className="lab-reset-example" onClick={loadExample}>Load example</button></div>
    <textarea id="rules" rows={6} maxLength={16000} value={text} onChange={e => setText(e.target.value)}
      placeholder="How many players? What cards do they receive? What can they do on a turn, and how does someone win?" />
    <button disabled={busy || !!pending || !text.trim()} onClick={() => void run(() => submit())}>Create game</button>
    {pending && <p role="status">{job.status === 'queued' ? 'Waiting for a compiler…' : 'Interpreting and checking your rules…'}</p>}
    {(error || job?.error) && <p role="alert" className="lab-error">{error || job?.error}</p>}
    {job?.report?.unsupported_mechanics.map(x => <p key={x}>Not supported yet: {x}</p>)}
    {job?.status === 'needs_clarification' && <div className="lab-review"><h3>A few rules to settle</h3>
      {job.report?.ambiguities.map((q, i) => <label key={q}>{q}<input aria-label={q} value={answers[q] ?? ''} onChange={e => setAnswers({ ...answers, [q]: e.target.value })} /></label>)}
      <button disabled={busy || job.report?.ambiguities.some(q => !answers[q]?.trim())} onClick={() => void run(() => submit(true))}>Update the rules</button>
    </div>}
    {job && ['validated', 'ready'].includes(job.status) && <div className="lab-review">
      <h3>Your game, interpreted</h3><p className="rules-summary">{job.rulesSummary}</p>
      <p>{job.validation?.reached_terminal}/{job.validation?.episodes} simulated games finished. {job.validation?.exhaustive ? 'All reachable branches checked.' : 'Bounded branch checks completed; this is not a proof of every possible game.'}</p>
      {!!job.report?.assumptions.length && <><h4>Assumptions</h4><ul>{job.report.assumptions.map(a => <li key={a}>{a}</li>)}</ul></>}
      {job.status === 'validated' && <>
        <label className="lab-check"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />These rules and assumptions match the game I want.</label>
        <button disabled={!acknowledged || busy} onClick={() => void run(async () => { const r = await labApi<{ job: Job }>(`/compile/jobs/${job.id}/accept`, { acknowledged }); setJob(r.job); })}>Accept rules</button>
        <button className="ghost" disabled={busy} onClick={() => void run(() => submit(true))}>Recompile edited rules</button>
      </>}
      {job.status === 'ready' && <div className="launch-row">
        <button disabled={busy} onClick={() => void run(async () => onLaunch(await share(), false))}>Play with friends</button>
        <button disabled={busy} onClick={() => void run(async () => onLaunch(await share(), true))}>Play vs AI</button>
        <button disabled={busy} onClick={() => void run(async () => { await share(); })}>Share</button>
      </div>}
      {shareId && <a className="share-link" href={`/shared/${shareId}`}>{window.location.origin}/shared/{shareId}</a>}
    </div>}
  </section>;
}
