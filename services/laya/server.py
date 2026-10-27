"""Laya decision service for the Game Night "Laya" AI seats (CPU).

POST /decide {"state": str, "questions": {...}} -> {"answers": {qid: label}, "ms": float}
GET  /healthz -> {"ok": true, "model": ...}

The model (LAYA_MODEL, a Hugging Face repo or local path) is downloaded on
first start into HF_HOME (mount a volume there). One request runs at a time;
Cabo decisions take ~0.3-0.6 s on a couple of CPU cores.
"""
import json, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

os.environ.setdefault("USE_TF", "0")
import torch
import laya

MODEL = os.environ.get("LAYA_MODEL", "Ojas-Singh/laya-cabo")
PORT = int(os.environ.get("PORT", "8000"))
torch.set_num_threads(int(os.environ.get("LAYA_THREADS", "4")))

agent = laya.load(MODEL, device="cpu")
lock = Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/healthz":
            self._send(200, {"ok": True, "model": MODEL})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/decide":
            return self._send(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
            t = time.time()
            with lock:
                try:
                    r = agent.predict(body["state"], body["questions"])
                except ValueError:
                    # Many options: allow a longer sequence than the default window.
                    r = agent.predict(body["state"], body["questions"], max_len=512)
            answers = {k: v.get("choice") for k, v in r["answers"].items()}
            self._send(200, {"answers": answers, "ms": round((time.time() - t) * 1000, 1)})
        except Exception as e:  # the game falls back to its heuristic bot
            self._send(400, {"error": repr(e)[:300]})


print(f"laya service: {MODEL} on :{PORT}", flush=True)
ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
