import json

import pytest

from rulezero.compiler_backend import EndpointCompiler


class Response:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, _limit):
        return self.payload


def test_endpoint_compiler_returns_data_and_disclosures(monkeypatch):
    monkeypatch.setenv('RULEZERO_COMPILER_URL', 'http://compiler.test/v1')
    monkeypatch.setenv('RULEZERO_COMPILER_MODEL', 'test-model')
    response = {
        'choices': [{'message': {'content': json.dumps({
            'spec': {'schemaVersion': 1},
            'report': {'ambiguities': ['tie?'], 'assumptions': [], 'unsupported_mechanics': []},
            'rules_summary': 'A tiny game', 'presentation': {'title': 'Tiny', 'description': 'demo'},
        })}}],
    }
    captured = {}

    def fake_open(request, timeout):
        captured['url'] = request.full_url
        captured['body'] = json.loads(request.data)
        captured['timeout'] = timeout
        return Response(response)

    monkeypatch.setattr('urllib.request.urlopen', fake_open)
    spec, report = EndpointCompiler(answers={'tie?': 'split'}).compile('Make a tiny game')
    assert spec == {'schemaVersion': 1}
    assert report.ambiguities == ['tie?']
    assert captured['url'] == 'http://compiler.test/v1/chat/completions'
    assert captured['body']['temperature'] == 0
    assert captured['timeout'] == 45


def test_endpoint_compiler_requires_configuration(monkeypatch):
    monkeypatch.delenv('RULEZERO_COMPILER_URL', raising=False)
    monkeypatch.delenv('RULEZERO_COMPILER_MODEL', raising=False)
    monkeypatch.delenv('RULEZERO_COMPILER_PROVIDER', raising=False)
    monkeypatch.delenv('OPENCODE_API_KEY', raising=False)
    monkeypatch.delenv('OPENCODE_GO_API_KEY', raising=False)
    with pytest.raises(RuntimeError, match='Compiler unavailable'):
        EndpointCompiler()


def test_opencode_go_defaults_to_openai_compatible_transport(monkeypatch):
    monkeypatch.delenv('RULEZERO_COMPILER_URL', raising=False)
    monkeypatch.delenv('RULEZERO_COMPILER_MODEL', raising=False)
    monkeypatch.setenv('OPENCODE_API_KEY', 'go-secret')
    monkeypatch.setenv('OPENCODE_GO_MODEL', 'opencode-go/mimo-v2.5')
    response = {
        'choices': [{'message': {'content': json.dumps({
            'spec': {'schemaVersion': 1},
            'report': {'ambiguities': [], 'assumptions': [], 'unsupported_mechanics': []},
        })}}],
    }
    captured = {}

    def fake_open(request, timeout):
        captured['url'] = request.full_url
        captured['headers'] = {k.lower(): v for k, v in request.header_items()}
        captured['body'] = json.loads(request.data)
        captured['timeout'] = timeout
        return Response(response)

    monkeypatch.setattr('urllib.request.urlopen', fake_open)
    spec, _ = EndpointCompiler(session_id='job-123').compile('A tiny game')
    assert spec == {'schemaVersion': 1}
    assert captured['url'] == 'https://opencode.ai/zen/go/v1/chat/completions'
    assert captured['body']['model'] == 'mimo-v2.5'
    assert captured['headers']['authorization'] == 'Bearer go-secret'
    assert captured['headers']['x-opencode-session'] == 'job-123'
    assert captured['headers']['user-agent'] == 'gamenight-rulezero/1.0'
    assert captured['timeout'] == 45


def test_endpoint_compiler_rejects_malformed_report(monkeypatch):
    monkeypatch.setenv('RULEZERO_COMPILER_URL', 'http://compiler.test')
    monkeypatch.setenv('RULEZERO_COMPILER_MODEL', 'test-model')
    response = {'choices': [{'message': {'content': json.dumps({'spec': {}, 'report': {}})}}]}
    monkeypatch.setattr('urllib.request.urlopen', lambda *_args, **_kwargs: Response(response))
    with pytest.raises(ValueError, match='compiler report'):
        EndpointCompiler().compile('bad response')
