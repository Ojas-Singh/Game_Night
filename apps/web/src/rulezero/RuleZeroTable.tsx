/**
 * Generic RuleZero game renderer (Phase-2 §15).
 *
 * Renders ANY GameSpec game from a `game-service/v1` structured view:
 * zones (public cards / owned hands / hidden piles), the current actor,
 * dense candidate action buttons, scores, and a terminal banner. Generated
 * games work immediately with zero custom React; polished games may later
 * provide their own renderer keyed off the same view payload.
 */
import { useState } from 'react';
import type { ServiceView, ServiceZone } from './types.js';

function ZoneCard({ value }: { value: number }) {
  return (
    <span className="rz-card" title={`card ${value}`}>
      {value}
    </span>
  );
}

function ZoneBox({ zone, viewer }: { zone: ServiceZone; viewer: number }) {
  const isMine = zone.visibility === 'owner' && zone.owner === viewer;
  const shown = zone.cards ?? null;
  return (
    <div
      className={`rz-zone ${isMine ? 'rz-mine' : ''} rz-${zone.visibility}`}
      data-zone={zone.id}
    >
      <div className="rz-zone-head">
        <span className="rz-zone-id">{zone.id}</span>
        {zone.owner !== null && (
          <span className="rz-owner">P{zone.owner}{isMine ? ' (you)' : ''}</span>
        )}
        {shown === null && (
          <span className="rz-count">×{zone.count ?? 0}</span>
        )}
      </div>
      <div className="rz-cards">
        {shown === null
          ? Array.from({ length: zone.count ?? 0 }, (_, i) => (
              <span key={i} className="rz-card rz-facedown" />
            ))
          : shown.map((c, i) => <ZoneCard key={i} value={c} />)}
      </div>
    </div>
  );
}

export default function RuleZeroTable({
  view,
  review,
  onAction,
}: {
  view: ServiceView;
  review?: {
    nashConv: number | null;
    decisions: {
      step: number;
      player: number;
      chosen?: string | null;
      referenceTop?: [string, number] | null;
      distribution: [string, number][];
    }[];
  };
  onAction?: (envActionId: number) => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const myTurn =
    !view.isTerminal &&
    view.currentActor !== null &&
    view.currentActor === view.player;

  return (
    <div className="rulezero-table" data-spec-hash={view.specHash}>
      <header className="rz-header">
        <span className="rz-phase">{view.phase ?? 'game'}</span>
        {myTurn ? (
          <span className="rz-turn rz-your-turn">Your move</span>
        ) : (
          <span className="rz-turn">
            {view.isTerminal
              ? 'Round complete'
              : `Waiting for P${view.currentActor ?? '?'}`}
          </span>
        )}
      </header>

      <section className="rz-zones">
        {view.zones.map((z) => (
          <ZoneBox key={z.id} zone={z} viewer={view.player} />
        ))}
      </section>

      {view.scores && Object.keys(view.scores).length > 0 && (
        <section className="rz-scores">
          {Object.entries(view.scores).map(([p, v]) => (
            <span key={p} className={`rz-score p${p}`}>
              P{p}: {v}
            </span>
          ))}
        </section>
      )}

      {!view.isTerminal && (
        <section className="rz-actions" aria-label="available actions">
          {view.candidates.length === 0 && (
            <span className="rz-wait">No decisions for you right now.</span>
          )}
          {myTurn &&
            view.candidates.map((c) => (
              <button
                key={c.candidateId}
                className="rz-action"
                onClick={() => onAction?.(c.environmentActionId)}
              >
                <span className="rz-aid">{c.candidateId}</span> {c.label}
              </button>
            ))}
        </section>
      )}

      {view.isTerminal && (
        <footer className="rz-terminal">
          Final:{' '}
          {Object.entries(view.scores ?? {})
            .map(([p, v]) => `P${p} ${v}`)
            .join(' · ') || 'game over'}
        </footer>
      )}

      <button
        className="ghost rz-info-toggle"
        onClick={() => setShowInfo((s) => !s)}
      >
        {showInfo ? 'Hide info state' : 'Info state'}
      </button>
      {showInfo && (
        <pre className="rz-info">{view.informationState}</pre>
      )}
      {view.isTerminal && review && review.decisions.length > 0 && (
        <section className="rz-review">
          <h3>Game Review</h3>
          <p className="muted">
            Reference strategy: CFR solver · exploitability{' '}
            {review.nashConv != null
              ? `NashConv ${review.nashConv.toFixed(4)}`
              : 'n/a'}
          </p>
          {review.decisions.map((d) => (
            <div key={d.step} className="rz-review-step">
              <div className="rz-review-head">
                Turn {d.step + 1} · seat {d.player}
                {d.referenceTop && d.chosen && (
                  <span className={d.chosen === d.referenceTop[0]
                    ? ' rz-good' : ' rz-bad'}>
                    {' '}you chose: {d.chosen.replace(/^A\d+:/, '')}
                  </span>
                )}
              </div>
              <ul>
                {d.distribution.map(([label, p]) => (
                  <li key={label}>
                    {label.replace(/^A\d+:/, '')}{' '}
                    <strong>{Math.round(p * 100)}%</strong>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
