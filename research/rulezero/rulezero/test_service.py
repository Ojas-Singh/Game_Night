"""End-to-end test of the internal game-service protocol (Milestone 4).

Drives the service exactly like the TS server will: spawn subprocess,
speak game-service/v1 line-JSON, play full episodes of every IR fixture
game, verify reconnect via snapshot/restore, and verify private zones stay
private in per-player views.
"""

from __future__ import annotations

import json
import random
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent


class ServiceClient:
    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "rulezero.service"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            cwd=str(HERE.parent), text=True)

    def ask(self, msg: dict) -> dict:
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=10)


def main() -> int:
    from rulezero.test_ir_games import KUHNISH, GOOFSEQ, CLAIM

    ok = True
    cli = ServiceClient()
    try:
        for name, spec in (("kuhnish", KUHNISH), ("goofseq", GOOFSEQ),
                           ("claim", CLAIM)):
            r = cli.ask({"op": "create", "spec": spec, "seed": 1})
            assert r["ok"], r
            rng = random.Random(0)
            terminal = False
            for _ in range(200):
                v = cli.ask({"op": "view", "player": 0})["view"]
                # §16 gate: private observations remain private through views
                if not v["isTerminal"]:
                    for q in range(2):
                        zid = f"hand{q}"
                        if q != 0:
                            seg = [s for s in v["observation"].split()
                                   if s.startswith(zid + "=")]
                            if seg and "[" in seg[0]:
                                print(f"FAIL {name}: view leaks {zid}: "
                                      f"{v['observation']}")
                                ok = False
                    if v["currentActor"] == 0 and not v["candidates"]:
                        print(f"FAIL {name}: actor has no candidates")
                        ok = False
                    for c in v["candidates"]:
                        if c["candidateId"] != \
                                f"A{c['environmentActionId']}":
                            print(f"FAIL {name}: candidate ids not dense")
                            ok = False
                if v["isTerminal"]:
                    terminal = True
                    break
                if v["currentActor"] != 0:
                    # engine only exposes one seat's decision at a time;
                    # drive other actors blindly via legalActions+apply.
                    la = cli.ask({"op": "legalActions",
                                  "player": v["currentActor"]})
                    acts = la["actions"]
                    if not acts:
                        break
                    r2 = cli.ask({"op": "apply",
                                  "player": v["currentActor"],
                                  "action": rng.choice(acts)})
                    if not r2["ok"]:
                        print(f"FAIL {name}: apply rejected {r2}")
                        ok = False
                        break
                    continue
                act = rng.choice([c["environmentActionId"]
                                  for c in v["candidates"]])
                r2 = cli.ask({"op": "apply", "player": 0, "action": act})
                if not r2["ok"]:
                    print(f"FAIL {name}: apply rejected {r2}")
                    ok = False
                    break
                terminal = r2.get("isTerminal", False)
            ret = cli.ask({"op": "returns"})
            print(("PASS" if terminal or ret.get("returns") else "FAIL"),
                  f"{name} episode through service (terminal={terminal}, "
                  f"returns={ret['returns']})")
            ok = ok and bool(ret.get("returns"))

            # reconnect: snapshot → restore → identical observation
            snap = cli.ask({"op": "snapshot"})["snap"]
            before = cli.ask({"op": "view", "player": 0})["view"]["observation"]
            r3 = cli.ask({"op": "restore", "state": snap})
            after = cli.ask({"op": "view", "player": 0})["view"]["observation"]
            good = r3["ok"] and before == after
            print(("PASS" if good else "FAIL"), f"{name} reconnect round-trip")
            ok = ok and good

        # specHash mismatch must be refused
        bad = dict(snap)
        bad["specHash"] = "0" * 64
        r = cli.ask({"op": "restore", "state": bad})
        print(("PASS" if not r["ok"] else "FAIL"),
              "restore refuses foreign specHash")
        ok = ok and not r["ok"]
    finally:
        cli.close()

    print("ALL PASS" if ok else "SOME FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
