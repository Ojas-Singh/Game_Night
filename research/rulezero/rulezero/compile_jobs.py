"""Persisted, bounded Lab jobs. Each computation runs in a disposable process."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid

from .gamespec_ir import ir_hash


def root() -> Path:
    path = Path(os.environ.get('RULEZERO_JOBS', Path(__file__).resolve().parent.parent / 'artifacts' / 'jobs'))
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_job(job_id: str) -> dict:
    if len(job_id) != 32 or any(c not in '0123456789abcdef' for c in job_id):
        raise ValueError('invalid job id')
    return json.loads((root() / f'{job_id}.json').read_text())


def save_job(job: dict):
    path = root() / f'{job["id"]}.json'
    tmp = path.with_suffix(f'.{uuid.uuid4().hex}.tmp')
    tmp.write_text(json.dumps(job, sort_keys=True, allow_nan=False))
    os.replace(tmp, path)


class LabJobs:
    def __init__(self):
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.slots = threading.BoundedSemaphore(8)
        # A killed worker is never advertised as still running after restart.
        for path in root().glob('*.json'):
            job = json.loads(path.read_text())
            if job['status'] in ('queued', 'drafting', 'validating', 'running'):
                job.update(status='failed', error='Worker restarted; retry this job.')
                save_job(job)

    def submit(self, kind: str, payload: dict, parent: str | None = None) -> dict:
        if not self.slots.acquire(blocking=False):
            raise ValueError('Lab queue full; try again shortly')
        job = {'id': uuid.uuid4().hex, 'kind': kind, 'status': 'queued',
               'createdAt': time.time(), 'payload': payload, 'parentId': parent}
        save_job(job)
        self.pool.submit(self._run, job)
        return job

    def _run(self, job: dict):
        try:
            job['status'] = 'drafting' if job['kind'] == 'compile' else 'running'
            save_job(job)
            result = subprocess.run([sys.executable, '-m', 'rulezero.compile_jobs', '--execute'],
                input=json.dumps(job), text=True, capture_output=True, timeout=1800 if job["kind"] == "training" else 180)
            if result.returncode:
                raise RuntimeError('Lab worker failed')
            output = json.loads(result.stdout)
            job.update(output)
        except subprocess.TimeoutExpired:
            job.update(status='failed', error='Lab job exceeded its time budget')
        except Exception as exc:
            job.update(status='failed', error=str(exc))
        finally:
            save_job(job)
            self.slots.release()


def execute(job: dict) -> dict:
    payload = job['payload']
    if job['kind'] == 'training':
        from .learning import run_training
        def progress(manifest):
            latest = read_job(job['id'])
            latest.update(status='running', learning=manifest)
            save_job(latest)
        result = run_training(payload, progress=progress,
                              cancelled=lambda: read_job(job['id']).get('cancelRequested', False))
        return {'status': result['status'], 'result': result}
    if job['kind'] == 'simulate':
        from .lab import simulate
        return {'status': 'ready', 'result': simulate(**payload)}
    from .compiler_backend import EndpointCompiler
    from .compiler import RuleCompilerLLM, compile_and_verify, CompileFailure
    rules = payload.get('text', '').strip()
    if not rules or len(rules) > 16000:
        return {'status': 'failed', 'error': 'Rules must contain 1..16000 characters'}
    history = list(payload.get('priorHistory', []))
    diagnostics = list(payload.get('diagnostics', []))
    # Keep one provider conversation across deterministic repair attempts so
    # OpenCode Go can retain routing and prompt-cache affinity for the job.
    session_id = str(payload.get('compilerSession') or job['id'])
    for attempt in range(3):
        compiler = EndpointCompiler(answers=payload.get('answers'), diagnostics=diagnostics,
                                   session_id=session_id)
        spec, report = compiler.compile(rules)
        history.append({'attempt': attempt, 'model': compiler.model, 'draft': spec,
                        'report': asdict(report), 'diagnostics': diagnostics})
        base = {'history': history, 'report': asdict(report), 'spec': spec,
                'diagnostics': diagnostics,
                'rulesSummary': compiler.last_payload.get('rules_summary', ''),
                'presentation': compiler.last_payload.get('presentation', {}),
                'compiler': {'name': compiler.name, 'model': compiler.model}}
        if report.unsupported_mechanics:
            return {**base, 'status': 'failed', 'error': 'Requested mechanics are unsupported'}
        if report.ambiguities:
            return {**base, 'status': 'needs_clarification'}
        class Fixed(RuleCompilerLLM):
            def compile(self, _rules):
                return spec, report
        result = compile_and_verify(Fixed(), rules)
        if not isinstance(result, CompileFailure):
            definition = result.definition.to_dict()
            definition['presentation'] = base['presentation']
            return {**base, 'status': 'validated', 'specHash': result.spec_hash,
                    'validation': result.smoke, 'definition': definition}
        diagnostics = result.diagnostics
    return {**base, 'status': 'failed', 'error': '; '.join(diagnostics)}


def accept(job_id: str, acknowledged: bool) -> dict:
    job = read_job(job_id)
    if job['status'] == 'ready':
        return job
    if job['status'] != 'validated':
        raise ValueError('Only a validated revision may be accepted')
    if job['report']['assumptions'] and acknowledged is not True:
        raise ValueError('Acknowledge the assumptions before publishing')
    job.update(status='ready', acceptedAt=time.time(), assumptionsAcknowledged=acknowledged)
    save_job(job)
    return job


if __name__ == '__main__':
    try:
        result = execute(json.load(sys.stdin))
    except Exception as exc:
        result = {'status': 'failed', 'error': str(exc)}
    print(json.dumps(result, allow_nan=False))
