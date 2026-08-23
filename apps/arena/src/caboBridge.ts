/**
 * Differential-verification bridge (research only): exposes the TypeScript
 * Cabo engine over a line-JSON stdio protocol so the Python side can drive
 * both engines through identical random episodes and compare semantics.
 *
 * Protocol in : {"op":"new","seed":42}
 *               {"op":"legalAll"}
 *               {"op":"apply","player":"p0","action":{...}}
 *               {"op":"snap"} | {"op":"done"}
 * Protocol out: one JSON object per line.
 */

import { CaboEngine } from '@game-night/engine-cabo';
import type { CaboState } from '@game-night/engine-cabo';
import { enumerateLegalActions } from '@game-night/agent-core';

let SEATS = [
  { id: 'p0', name: 'P0', seat: 0 },
  { id: 'p1', name: 'P1', seat: 1 },
];

function setPlayerCount(n: number): void {
  SEATS = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i }));
}

let engine: CaboEngine | null = null;

function idxOf(cardId: string): number {
  return Number(cardId.slice(2));
}

function rankOf(cardIdx: number): number {
  return (cardIdx % 13) + 1;
}

function snap() {
  const s = engine!.getState() as CaboState;
  return {
    phase: s.phase,
    currentTurn: s.currentTurn,
    handsIdx: Object.fromEntries(
      Object.entries(s.hands).map(([pid, hand]) => [
        pid,
        hand.map((c) => (c ? idxOf(c.id) : null)),
      ]),
    ) as Record<string, (number | null)[]>,
    deckLen: s.deck.length,
    discardTop: s.discard.length ? idxOf(s.discard[s.discard.length - 1]!.id) : null,
    discardLen: s.discard.length,
    drawnIdx: s.drawnCard ? idxOf(s.drawnCard.id) : null,
    pendingPower: s.pendingPower ? { seat: pidSeat(s.pendingPower.playerId), power: s.pendingPower.power } : null,
    pendingTransfer: s.pendingTransfer
      ? { from: pidSeat(s.pendingTransfer.fromPlayerId), to: pidSeat(s.pendingTransfer.toPlayerId) }
      : null,
    caboCaller: s.cabo ? pidSeat(s.cabo.callerId) : null,
    takenFinalTotal: s.cabo ? s.cabo.takenFinalTurn.length : 0,
    initialPeeksLeft: s.initialPeeksRemaining.length,
    scores: s.scores ?? null,
    knowledge: Object.fromEntries(
      Object.entries(s.knowledge).map(([pid, ks]) => [pid, [...ks].map(idxOf).sort((a, b) => a - b)]),
    ),
  };
}

function pidSeat(pid: string): number {
  const i = SEATS.findIndex((s) => s.id === pid);
  if (i < 0) throw new Error(`unknown pid ${pid}`);
  return i;
}

const lines: string[] = [];
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) void handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));

async function handle(line: string): Promise<void> {
  try {
    const msg = JSON.parse(line) as Record<string, unknown>;
    switch (msg.op) {
      case 'new': {
        setPlayerCount(Number(msg.players ?? 2));
        engine = new CaboEngine();
        engine.createGame(SEATS, { seed: msg.seed as number });
        out({ ok: true });
        return;
      }
      case 'legalAll': {
        const s = engine!.getState() as CaboState;
        const all: Array<{ player: string; action: unknown }> = [];
        if (!engine!.isGameFinished()) {
          const actors =
            s.phase === 'INITIAL_PEEK'
              ? [s.initialPeeksRemaining[0]!]
              : SEATS.map((x) => x.id); // off-turn flushes are legal for anyone
          for (const pid of actors) {
            const view = (
              await import('@game-night/engine-cabo')
            ).buildPlayerView(s, pid);
            for (const a of enumerateLegalActions(view as never, pid)) {
              if (engine!.validateAction(a)) all.push({ player: pid, action: a });
            }
          }
        }
        out({ ok: true, actions: all });
        return;
      }
      case 'apply': {
        // handleAction REPORTS failures via its result object; it does not
        // throw for rule violations. Surface them honestly to the driver.
        try {
          const res = engine!.handleAction(msg.action as never);
          if (res.ok) out({ ok: true });
          else out({ ok: false, error: res.error ?? 'rejected', rejected: true });
        } catch (err) {
          out({ ok: false, error: String(err).slice(0, 200), threw: true });
        }
        return;
      }
      case 'snap':
        out({ ok: true, snap: snap() });
        return;
      case 'done':
        out({ ok: true, done: engine!.isGameFinished(), scores: engine!.getState().scores ?? null });
        return;
      default:
        out({ ok: false, error: `unknown op ${String(msg.op)}` });
    }
  } catch (err) {
    out({ ok: false, error: String(err).slice(0, 300) });
  }
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// keepalive so tsx doesn't exit while idle
setInterval(() => undefined, 1 << 30);
lines.length = 0;
