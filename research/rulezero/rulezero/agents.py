"""RuleZero agent interfaces (Phase 9/12/13).

An Agent receives the game, state, and its seat; it returns a REAL action id
chosen from state.legal_actions(seat). Research-strict contract: an agent
that cannot act raises StrictFailure — the runner records it; nothing here
silently rescues a model with a smarter policy.
"""

from __future__ import annotations

import json
import time
import urllib.request
from typing import Optional

from .serialize import render_observation


class StrictFailure(Exception):
    """Raised in research-strict mode when a model produces no usable action."""


class Agent:
    name = "agent"

    def describe(self) -> dict:
        return {"kind": self.__class__.__name__}

    def act(self, game, state, seat: int) -> int:  # pragma: no cover - interface
        raise NotImplementedError


class RandomAgent(Agent):
    """Uniform over legal actions — the floor every agent must clear."""

    def __init__(self, rng):
        self.rng = rng
        self.name = "random"

    def describe(self) -> dict:
        return {"kind": "random"}

    def act(self, game, state, seat: int) -> int:
        legal = state.legal_actions(seat)
        return int(legal[self.rng.randrange(len(legal))])


class TeacherAgent(Agent):
    """Plays the argmax of a Teacher policy — how strong teachers are in play."""

    def __init__(self, teacher):
        self.teacher = teacher
        self.name = f"teacher:{teacher.name}"

    def describe(self) -> dict:
        return {"kind": "teacher", **self.teacher.quality()}

    def act(self, game, state, seat: int) -> int:
        probs = self.teacher.policy(game, state, seat)
        return max(probs.items(), key=lambda kv: kv[1])[0]


class OpenAIAgent(Agent):
    """OpenAI-compatible strict agent for local endpoints (Ollama/vLLM/llama.cpp).

    research-strict: invalid JSON or unknown/illegal action id => StrictFailure.
    One corrective retry is allowed as part of the decision procedure; after
    that the failure is recorded exactly as it happened.
    """

    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        api_key: str = "",
        temperature: float = 0.2,
        max_tokens: int = 500,
        timeout_s: float = 60.0,
        mode: str = "research-strict",
        name_suffix: str = "",
        no_think: bool = True,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.timeout_s = timeout_s
        assert mode == "research-strict", "live-safe fallback does not exist in research"
        self.no_think = no_think
        self.name = f"llm:{model}{name_suffix}"
        # metrics
        self.decisions = 0
        self.parse_failures = 0
        self.invalid_ids = 0
        self.retries = 0
        self.latency_ms_total = 0
        self.thinking_chars_total = 0
        self.thinking_decisions = 0
        self.last_candidate_id: str | None = None

    def describe(self) -> dict:
        return {
            "kind": "openai-compatible",
            "model": self.model,
            "baseUrl": self.base_url,
            "temperature": self.temperature,
            "maxTokens": self.max_tokens,
            "noThink": self.no_think,
            "mode": "research-strict",
        }

    def _chat(self, messages: list[dict]) -> str:
        body = json.dumps({
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }).encode()
        content, _chars = self._post(body)
        return content

    def _post(self, body: bytes) -> tuple[str, int]:
        """Returns (content, reasoning_chars). Handles both llama.cpp layouts:
        reasoning in message.reasoning_content, or inline <think>...</think>."""
        import re

        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=body,
            headers={"content-type": "application/json", **({"authorization": f"Bearer {self.api_key}"} if self.api_key else {})},
        )
        with urllib.request.urlopen(req, timeout=self.timeout_s) as res:
            payload = json.loads(res.read())
        msg = payload["choices"][0]["message"]
        content = msg.get("content") or ""
        reasoning = msg.get("reasoning_content") or ""
        if "<think>" in content:  # inline layout
            m = re.search(r"<think>([\s\S]*?)</think>", content)
            if m:
                reasoning += m.group(1)
                content = re.sub(r"<think>[\s\S]*?</think>", "", content)
        elif not reasoning and content.startswith("<think>"):
            # unterminated think block that consumed everything
            reasoning += content
            content = ""
        chars = len(reasoning.strip())
        if chars:
            self.thinking_chars_total += chars
            self.thinking_decisions += 1
        return content.strip(), chars

    @staticmethod
    def _extract_json(text: str) -> Optional[dict]:
        import re

        fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
        raw = fence.group(1) if fence else text
        start, end = raw.find("{"), raw.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            return json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            return None

    def act(self, game, state, seat: int) -> int:
        legal = set(state.legal_actions(seat))
        from .serialize import candidate_map

        cmap = candidate_map(sorted(legal))  # dense A0..An -> env action ids
        observation = render_observation(game, state, seat)
        system = (
            "You are a world-class strategic card player. You will receive game rules, "
            'your situation, and a list of legal actions with ids A0..An. Respond with ONE '
            'json object and nothing else: {"thought": "<=2 sentences", "action_id": "A<n>"}.'
        )
        if self.no_think:
            system += " /no_think"
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": observation},
        ]

        last_err = ""
        for attempt in range(2):  # one corrective retry, then strict failure
            self.decisions += 1
            t0 = time.monotonic()
            try:
                text = self._chat(messages)
            except Exception as e:  # endpoint errors are failures too
                last_err = f"http:{e}"
                continue
            finally:
                self.latency_ms_total += int((time.monotonic() - t0) * 1000)
            parsed = self._extract_json(text)
            if not parsed:
                self.parse_failures += 1
                last_err = f"unparseable: {text[:120]}"
            else:
                aid_raw = parsed.get("action_id")
                if isinstance(aid_raw, str) and aid_raw.strip() in cmap:
                    self.last_candidate_id = aid_raw.strip()
                    return int(cmap[aid_raw.strip()])
                self.invalid_ids += 1
                last_err = f"invalid action_id: {aid_raw!r}"
            messages.append({"role": "assistant", "content": text[:400]})
            messages.append({
                "role": "user",
                "content": f"Your previous answer was rejected: {last_err}. Reply again with valid JSON choosing EXACTLY one listed action id.",
            })
            self.retries += 1
        raise StrictFailure(f"{self.name}: {last_err}")

    def metrics(self) -> dict:
        d = max(1, self.decisions)
        return {
            "decisions": self.decisions,
            "parseFailures": self.parse_failures,
            "thinkingCharsTotal": self.thinking_chars_total,
            "avgThinkingChars": round(self.thinking_chars_total / max(1, self.thinking_decisions)),
            "thinkingDecisions": self.thinking_decisions,
            "invalidActionIds": self.invalid_ids,
            "retries": self.retries,
            "avgLatencyMs": round(self.latency_ms_total / d),
        }
