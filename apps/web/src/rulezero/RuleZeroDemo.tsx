/**
 * Dev harness: renders the generic RuleZero table against a captured
 * service view fixture (and a terminal one), proving the renderer works
 * for arbitrary GameSpec games without a live backend. Live play goes
 * browser → TS server → rulezero service (see docs/GAME_RUNTIME_PROTOCOL.md).
 */
import { useState } from 'react';
import RuleZeroTable from './RuleZeroTable.js';
import type { ServiceView } from './types.js';

const LIVE: ServiceView = {
  protocol: 'game-service/v1',
  specHash: 'demo',
  player: 0,
  phase: 'act1',
  observation: "phase=act1 deck=hidden(2) hand0=[10] hand1=hidden(1) prize=[3]",
  informationState:
    '[p0] phase=act1 hand0=[10] hand1=hidden(1) prize=[3] hist=p0:A0 ',
  isTerminal: false,
  currentActor: 0,
  candidates: [
    { candidateId: 'A0', environmentActionId: 0, label: 'A0:fold' },
    { candidateId: 'A1', environmentActionId: 1, label: 'A1:call' },
  ],
  zones: [
    { id: 'deck', visibility: 'hidden', owner: null, count: 2 },
    { id: 'hand0', visibility: 'owner', owner: 0, cards: [10] },
    { id: 'hand1', visibility: 'owner', owner: 1, count: 1 },
    { id: 'prize', visibility: 'public', owner: null, cards: [3] },
  ],
  scores: { 0: -1, 1: -1 },
};

const TERMINAL: ServiceView = {
  ...LIVE,
  phase: 'end',
  isTerminal: true,
  currentActor: null,
  candidates: [],
  scores: { 0: 1, 1: -1 },
};

export default function RuleZeroDemo() {
  const [view, setView] = useState<ServiceView>(LIVE);
  return (
    <div className="page">
      <h2 className="font-display">RuleZero — generated game (generic renderer)</h2>
      <p className="home-sub">
        Any GameSpec game rendered from its service view. No custom UI code.
      </p>
      <div className="rz-demo-actions">
        <button className="ghost" onClick={() => setView(LIVE)}>
          Mid-game view
        </button>
        <button className="ghost" onClick={() => setView(TERMINAL)}>
          Terminal view
        </button>
      </div>
      <RuleZeroTable view={view} onAction={() => setView(TERMINAL)} />
    </div>
  );
}
