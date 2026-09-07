import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class ServiceError extends Error {}

/** One ordered channel per runtime. A failed channel is killed, never reused. */
export class RuleZeroClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;

  constructor(private timeoutMs = 10_000) {}

  private start(): void {
    if (this.closed) throw new Error('service disposed');
    if (this.proc) return;
    const home = process.env.RULEZERO_HOME ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../research/rulezero');
    const python = process.env.RULEZERO_PYTHON ?? path.join(home, '.venv/bin/python');
    const proc = spawn(python, ['-m', 'rulezero.service'], { cwd: home, env: { ...process.env, PYTHONPATH: home } });
    this.proc = proc;
    this.lines = createInterface(proc.stdout);
    this.lines.on('line', (line) => {
      let response: any;
      try { response = JSON.parse(line); } catch { this.fail(new Error('invalid service response')); return; }
      const p = this.pending.get(response.requestId);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(response.requestId);
      if (response.ok === false) p.reject(new ServiceError(response.error ?? response.diagnostics?.join('; ') ?? 'service rejected request'));
      else p.resolve(response);
    });
    proc.stderr.on('data', () => { /* service diagnostics stay off public payloads */ });
    proc.on('error', (e) => { if (this.proc === proc) this.fail(e); });
    proc.on('exit', () => { if (this.proc === proc) this.fail(new Error('service exited')); });
  }

  private fail(error: Error): void {
    const proc = this.proc;
    this.proc = null;
    this.lines?.close();
    this.lines = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    proc?.kill();
  }

  ask<T>(msg: Record<string, unknown>): Promise<T> {
    const run = (): Promise<T> => {
      this.start();
      const requestId = ++this.seq;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => this.fail(new Error('service timeout')), this.timeoutMs);
        this.pending.set(requestId, { resolve, reject, timer });
        this.proc!.stdin.write(JSON.stringify({ ...msg, requestId }) + '\n', (e) => { if (e) this.fail(e); });
      });
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  dispose(): void { this.closed = true; this.fail(new Error('service disposed')); }
}
