"""Generic OpenSpiel episode recorder — Python twin of TS trajectory schema v2.

Same guarantees: provenance in every record, proposed vs executed distinct
(OpenSpiel agents can only return legal ids, so proposalWasLegal is true by
construction; StrictFailure episodes mark the decision as a recorded failure),
raw files are immutable once written.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 2

_seq = 0


def _sha1(obj) -> str:
    return hashlib.sha1(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()


class EpisodeRecorder:
    def __init__(self, game_desc: dict, seed: int, agents: list[dict]):
        global _seq
        _seq += 1
        self.started_at = datetime.now(timezone.utc).isoformat()
        core = _sha1([game_desc["gameId"], seed, [a["name"] for a in agents], game_desc["rulesHash"]])
        self.record = {
            "schemaVersion": SCHEMA_VERSION,
            "episodeId": f"{game_desc['gameId']}-s{seed}-{core[:10]}-{_seq:x}",
            "gameId": game_desc["gameId"],
            "gameVersion": game_desc["rulesVersion"],
            "rulesHash": game_desc["rulesHash"],
            "engineVersion": f"openspiel-{game_desc.get('openspielVersion', '?')}",
            "seed": seed,
            "seatPermutation": [f"p{i}" for i in range(game_desc["players"])],
            "players": [
                {"id": f"p{i}", "name": a["name"], "agentId": a["name"], "seat": i}
                for i, a in enumerate(agents)
            ],
            "agentConfigurations": {a["name"]: a.get("config", {}) for a in agents},
            "startedAt": self.started_at,
            "finishedAt": None,
            "steps": [],
            "result": None,
        }

    def step(
        self,
        step: int,
        seat: int,
        agent_name: str,
        action_id: int,
        action_str: str,
        observation_hash: str,
        rationale: str | None = None,
        latency_ms: int | None = None,
        teacher: dict | None = None,
    ):
        row = {
            "decisionId": f"{self.record['episodeId']}-d{step}",
            "step": step,
            "selfId": f"p{seat}",
            "agentId": agent_name,
            "decisionKind": "agent",
            "proposedAction": str(action_id),
            "executedAction": str(action_id),
            "actionString": action_str,
            "proposalWasLegal": True,  # OpenSpiel agents choose from legal_actions
            "fallbackUsed": False,
            "observationHash": observation_hash,
            **({"rationale": rationale} if rationale else {}),
            **({"latencyMs": latency_ms} if latency_ms is not None else {}),
            **({"teacher": teacher} if teacher else {}),
        }
        self.record["steps"].append(row)

    def step_failed(self, step: int, seat: int, agent_name: str, error: str, observation_hash: str):
        """A strict-mode model failure at this decision point."""
        self.record["steps"].append({
            "decisionId": f"{self.record['episodeId']}-d{step}",
            "step": step,
            "selfId": f"p{seat}",
            "agentId": agent_name,
            "decisionKind": "fallback",
            "proposedAction": None,
            "executedAction": None,
            "proposalWasLegal": False,
            "fallbackUsed": True,
            "fallbackReason": "strict_failure",
            "error": error[:300],
            "observationHash": observation_hash,
        })

    def finish(self, returns: list[float]):
        self.record["result"] = {
            "returns": {f"p{i}": r for i, r in enumerate(returns)},
            "winnerIds": [f"p{i}" for i, r in enumerate(returns) if r == max(returns)],
            "steps": len(self.record["steps"]),
        }
        self.record["finishedAt"] = datetime.now(timezone.utc).isoformat()
        return self.record


def append_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(record) + "\n")
