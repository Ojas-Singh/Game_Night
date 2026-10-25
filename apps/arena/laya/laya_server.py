"""Tiny decision service for the Cabo evaluation: POST /decide {state, questions}
-> {answers: {qid: label}, probabilities, ms}. Keeps one model resident."""
import argparse, json, os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

os.environ.setdefault("USE_TF", "0")
import laya

ap = argparse.ArgumentParser()
ap.add_argument("--model", required=True)
ap.add_argument("--port", type=int, default=8765)
ap.add_argument("--device", default=None)
a = ap.parse_args()
agent = laya.load(a.model, device=a.device)
lock = Lock()


class H(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        t = time.time()
        try:
            with lock:
                r = agent.predict(body["state"], body["questions"])
        except ValueError:
            # Many options: let the sequence grow past the training window.
            with lock:
                r = agent.predict(body["state"], body["questions"], max_len=512)
        ans = r["answers"]
        out = {
            "answers": {k: v.get("choice") for k, v in ans.items()},
            "probabilities": {k: v.get("probabilities") for k, v in ans.items()},
            "ms": round((time.time() - t) * 1000, 1),
        }
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


print(f"serving {a.model} on :{a.port}", flush=True)
ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()
