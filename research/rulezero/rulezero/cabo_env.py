"""Cabo as an OpenSpiel game — research twin of packages/engine-cabo.

Fidelity contract (verified differentially against the TypeScript engine):
  - identical xoshiro128** RNG, splitmix32 seeding, Fisher-Yates shuffle and
    standard-deck construction -> identical deals from the same seed;
  - identical phases: INITIAL_PEEK -> TURN_DRAW -> DRAW_DECISION ->
    (POWER_PENDING | TRANSFER_PENDING)? -> TURN_END -> ... -> ROUND_COMPLETE;
  - mandatory powers after discards, with the TS skip conditions;
  - off-turn flushes allowed whenever TS allows them (any phase except
    INITIAL_PEEK / ROUND_REVEAL / ROUND_COMPLETE; FLUSH_OTHER blocked during
    TRANSFER_PENDING);
  - failed OWN flush is public + penalty draw; failed OTHER flush is private
    penalty draw; successful OTHER flush forces a transfer of one of the
    flusher's cards into the target's hand;
  - empty deck reshuffles discard-minus-top through the same RNG stream;
  - Cabo call at TURN_END, zero-card auto-Cabo, caller excluded from final
    turns, othersFinalTurns budget, lowest score wins, tie goes to caller.

Deliberate deviation (documented): deals are resolved from the game seed
internally instead of explicit chance nodes — 52! chance trees cannot be
enumerated, so solver-style chance enumeration is replaced by seed-driven
sampling. chance_mode is therefore reported as DETERMINISTIC; sampling-based
methods should drive episodes through this module or the arena, not through
generic chance enumerators.

Actions are encoded as packed ints; see _encode/_decode below.
"""

from __future__ import annotations

import random
from typing import Any

import pyspiel

# ---------------------------------------------------------------------------
# Cards / rules constants (mirroring shared/cards.ts + engine-cabo/rules.ts)
# ---------------------------------------------------------------------------

SUITS = ("spades", "hearts", "diamonds", "clubs")  # canonical order


def rank_of(card: int) -> int:
    return (card % 13) + 1


def suit_of(card: int) -> int:
    return card // 13


def is_red(card: int) -> bool:
    return suit_of(card) in (1, 2)


def card_value(card: int) -> int:
    r = rank_of(card)
    if r == 13:
        return 13 if is_red(card) else -1
    return r


def power_for_rank(rank: int) -> str | None:
    # DEFAULT_CABO_RULES: swapOthersEnabled=false so 5-6 carries no power.
    if 7 <= rank <= 8:
        return "PEEK_OWN"
    if 9 <= rank <= 10:
        return "PEEK_OTHER"
    if 11 <= rank <= 12:
        return "BLIND_SWAP"
    return None


def make_deck() -> list[int]:
    return list(range(52))

_RANK_LABELS = {1: "A", 11: "J", 12: "Q", 13: "K"}
_SUIT_LABELS = ("S", "H", "D", "C")


def card_label(card: int) -> str:
    """Public textual identity, e.g. 7H / KS / AD."""
    r = rank_of(card)
    return f"{_RANK_LABELS.get(r, str(r))}{_SUIT_LABELS[suit_of(card)]}"


# ---------------------------------------------------------------------------
# TS RNG replica (shared/src/rng.ts): splitmix32 seeding + xoshiro128**
# ---------------------------------------------------------------------------

_U32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & _U32


class TsRng:
    def __init__(self, seed: int):
        x = seed & _U32

        def mix() -> int:
            nonlocal x
            x = (x + 0x9E3779B9) & _U32
            z = x
            z = _imul(z ^ (z >> 16), 0x21F0AAAD)
            z = _imul(z ^ (z >> 15), 0x735A2D97)
            return (z ^ (z >> 15)) & _U32

        self.s0 = mix() | 1
        self.s1 = mix() | 1
        self.s2 = mix() | 1
        self.s3 = mix() | 1

    def next(self) -> float:
        s0, s1, s2, s3 = self.s0, self.s1, self.s2, self.s3
        result = _imul(s1, 7)
        t = (s1 << 9) & _U32
        s2 = (s2 ^ s0) & _U32
        s3 = (s3 ^ s1) & _U32
        s1 = (s1 ^ s2) & _U32
        s0 = (s0 ^ s3) & _U32
        s2 = (s2 ^ t) & _U32
        s3 = _imul(s3, 9)
        self.s0, self.s1, self.s2, self.s3 = s0, s1, s2, s3
        return result / 4294967296

    def int(self, n: int) -> int:
        import math

        return math.floor(self.next() * n)

    def shuffle(self, items: list) -> list:
        out = list(items)
        for i in range(len(out) - 1, 0, -1):
            j = self.int(i + 1)
            out[i], out[j] = out[j], out[i]
        return out


# ---------------------------------------------------------------------------
# Action encoding
# ---------------------------------------------------------------------------
# Internal action tuples -> packed ints. Fields are < 64 unless noted.
K_DRAW, K_KEEP, K_DISCARD_DRAWN, K_PEEK, K_POWER_PO, K_POWER_PT, K_POWER_BS, \
    K_POWER_SO, K_FLUSH_OWN, K_FLUSH_OTHER, K_TRANSFER, K_CALL, K_END, \
    K_PASS = range(14)

_KIND_NAMES = {
    K_DRAW: "DRAW", K_KEEP: "KEEP_DRAWN", K_DISCARD_DRAWN: "DISCARD_DRAWN",
    K_PEEK: "PEEK_STARTING", K_POWER_PO: "POWER_APPLY/PEEK_OWN",
    K_POWER_PT: "POWER_APPLY/PEEK_OTHER", K_POWER_BS: "POWER_APPLY/BLIND_SWAP",
    K_POWER_SO: "POWER_APPLY/SWAP_OTHERS", K_FLUSH_OWN: "FLUSH_OWN",
    K_FLUSH_OTHER: "FLUSH_OTHER", K_TRANSFER: "TRANSFER_CARD",
    K_CALL: "CALL_CABO", K_END: "END_TURN", K_PASS: "PASS",
}


def encode_action(kind: int, *fields: int) -> int:
    v = kind
    for f in fields:
        v = v * 64 + int(f)
    return v


def decode_action(action: int) -> tuple[int, tuple[int, ...]]:
    fields: list[int] = []
    v = action
    while v >= 64:
        fields.append(v % 64)
        v //= 64
    kind = v
    return kind, tuple(reversed(fields))


# ---------------------------------------------------------------------------
# The game
# ---------------------------------------------------------------------------

PHASE_INITIAL_PEEK = "INITIAL_PEEK"
PHASE_TURN_DRAW = "TURN_DRAW"
PHASE_DRAW_DECISION = "DRAW_DECISION"
PHASE_POWER_PENDING = "POWER_PENDING"
PHASE_TRANSFER_PENDING = "TRANSFER_PENDING"
PHASE_TURN_END = "TURN_END"
PHASE_ROUND_COMPLETE = "ROUND_COMPLETE"

MAX_SLOTS = 63


class CaboState(pyspiel.State):
    """Two-player research Cabo (differential-verified configuration)."""

    def __init__(self, game: "CaboGame"):
        super().__init__(game)
        g: CaboGame = game
        n = g.num_players()
        # Canonical stochasticity (Phase-2 §6): NO internal RNG. Card
        # uncertainty lives in OpenSpiel chance nodes over the remaining
        # pool; the seed only names the episode.
        self.pool = sorted(make_deck())
        self.phase = PHASE_INITIAL_PEEK
        self.hands: list[list[int | None]] = [[] for _ in range(n)]
        self.knowledge: list[set[int]] = [set() for _ in range(n)]
        self.discard: list[int] = []
        self.current_turn = 0
        self.drawn_card: int | None = None
        self.pending_power: tuple[int, str] | None = None  # (seat, power)
        self.pending_transfer: tuple[int, int] | None = None  # (from,to)
        self.cabo_caller: int | None = None
        self.taken_final: list[int] = []
        self.initial_peeks_remaining = list(range(n))
        self.scores: list[float] | None = None
        self.final_scores: list[float] | None = None
        self.winner: int | None = None
        self._pre_transfer_phase = PHASE_TURN_DRAW
        # §5 reaction window: deterministic seat-order pass-through.
        self.window = None  # {'queue': tuple(seats), 'i': int, 'resume': str}
        # §6 chance context: ('deal',seat) | ('draw',seat,'turn'|'penalty')
        self.chance_ctx = None
        self._post_penalty = None
        self._deal_queue = [(pp, k) for k in range(4) for pp in range(n)]
        self.chance_ctx = ("deal",) + self._deal_queue[0]

    def _reseed_deal(self, seed: int):
        """Reset to the initial chance-deal state; seed names the episode."""
        n = len(self.hands)
        self.pool = sorted(make_deck())
        self.phase = PHASE_INITIAL_PEEK
        self.hands = [[] for _ in range(n)]
        self.knowledge = [set() for _ in range(n)]
        self.discard = []
        self.current_turn = 0
        self.drawn_card = None
        self.pending_power = None
        self.pending_transfer = None
        self.cabo_caller = None
        self.taken_final = []
        self.initial_peeks_remaining = list(range(n))
        self.scores = None
        self.final_scores = None
        self.winner = None
        self._pre_transfer_phase = PHASE_TURN_DRAW
        self.window = None
        self.chance_ctx = None
        self._post_penalty = None
        self._deal_queue = [(pp, k) for k in range(4) for pp in range(n)]
        self.chance_ctx = ("deal",) + self._deal_queue[0]

    # -- helpers ------------------------------------------------------------
    def _live(self, p: int) -> int:
        return sum(1 for c in self.hands[p] if c is not None)

    def _find(self, p: int, card: int) -> int:
        for i, c in enumerate(self.hands[p]):
            if c == card:
                return i
        return -1

    def _learn(self, p: int, card: int):
        self.knowledge[p].add(card)

    def _forget_all(self, card: int):
        for ks in self.knowledge:
            ks.discard(card)

    def _reveal_to_all(self, card: int):
        for ks in self.knowledge:
            ks.add(card)

    def _place_card(self, p: int, card: int):
        for i, c in enumerate(self.hands[p]):
            if c is None:
                self.hands[p][i] = card
                return
        self.hands[p].append(card)

    def _others(self, p: int) -> list[int]:
        return [i for i in range(len(self.hands)) if i != p]

    # -- OpenSpiel queries ---------------------------------------------------
    def is_chance_node(self):
        return self.chance_ctx is not None

    def chance_outcomes(self):
        """§6: card uncertainty as explicit finite distributions (uniform
        over the remaining pool)."""
        assert self.chance_ctx is not None
        n = len(self.pool)
        return [(c, 1.0 / n) for c in self.pool]

    def current_player(self):
        if self.is_terminal():
            return pyspiel.PlayerId.TERMINAL
        if self.chance_ctx is not None:
            return pyspiel.PlayerId.CHANCE
        if self.window is not None:
            return self.window["queue"][self.window["i"]]
        if self.phase == PHASE_INITIAL_PEEK:
            return self.initial_peeks_remaining[0]
        return self.current_turn

    def is_terminal(self):
        return self.phase == PHASE_ROUND_COMPLETE

    def returns(self):
        """Bounded strategic utility (Phase-2 §4).

        Cabo point totals are NOT zero-sum and must not leak into the game
        utility: lower hand score wins, ties go to the Cabo caller (TS
        endRound semantics). Utility here is strictly outcome-shaped:

            win  = +1
            tie (no decided winner) = 0
            loss = -1

        Raw hand point totals remain available separately via final_scores
        for trajectory metadata; they are deliberately NOT the utility.
        """
        if self.winner is None:
            return [0.0, 0.0]
        out = [-1.0, -1.0]
        out[self.winner] = 1.0
        return list(out)

    def legal_actions(self, player):
        acts: list[int] = []
        if self.is_terminal() or self.chance_ctx is not None:
            return acts
        if self.window is not None:
            # §5: the queued seat decides PASS or one flush attempt.
            if player != self.window["queue"][self.window["i"]]:
                return acts
            acts.append(encode_action(K_PASS))
            acts.extend(self._flush_actions(player))
            return acts
        if self.phase == PHASE_INITIAL_PEEK:
            if player != self.initial_peeks_remaining[0]:
                return acts
            hand_len = len(self.hands[player])
            for i in range(min(hand_len, MAX_SLOTS)):
                for j in range(i + 1, min(hand_len, MAX_SLOTS)):
                    acts.append(encode_action(K_PEEK, i, j))
            return acts
        # §5: off-turn flushes are explicit window decisions now; while a
        # transfer is pending only the flusher may act.
        if player != self.current_turn:
            return acts
        # Current player actions by phase.
        if self.phase == PHASE_TURN_DRAW:
            if self.pool or len(self.discard) > 1 or (not self.pool and self.discard):
                # A card must actually be obtainable (deck pool, or a
                # reshufflable discard beyond its top) before DRAW is legal.
                acts.append(encode_action(K_DRAW))
            acts.extend(self._flush_actions(player))
            return acts
        if self.phase == PHASE_DRAW_DECISION:
            for slot in range(len(self.hands[player])):
                if self.hands[player][slot] is not None:
                    acts.append(encode_action(K_KEEP, slot))
            acts.append(encode_action(K_DISCARD_DRAWN))
            acts.extend(self._flush_actions(player))
            return acts
        if self.phase == PHASE_POWER_PENDING:
            seat, power = self.pending_power
            assert seat == player
            if power == "PEEK_OWN":
                for slot in range(len(self.hands[player])):
                    if self.hands[player][slot] is not None:
                        acts.append(encode_action(K_POWER_PO, slot))
            elif power == "PEEK_OTHER":
                for o in self._others(player):
                    for slot in range(len(self.hands[o])):
                        if self.hands[o][slot] is not None:
                            acts.append(encode_action(K_POWER_PT, o, slot))
            elif power == "BLIND_SWAP":
                for slot in range(len(self.hands[player])):
                    if self.hands[player][slot] is None:
                        continue
                    for o in self._others(player):
                        for oslot in range(len(self.hands[o])):
                            if self.hands[o][oslot] is not None:
                                acts.append(encode_action(K_POWER_BS, slot, o, oslot))
            acts.extend(self._flush_actions(player))
            return acts
        if self.phase == PHASE_TRANSFER_PENDING:
            src = self.pending_transfer[0]
            assert src == player
            for slot in range(len(self.hands[player])):
                if self.hands[player][slot] is not None:
                    acts.append(encode_action(K_TRANSFER, slot))
            acts.extend(self._flush_actions(player, include_other=False))
            return acts
        if self.phase == PHASE_TURN_END:
            acts.append(encode_action(K_END))
            if self.cabo_caller is None:  # TS: 'cabo already called' INVALID
                acts.append(encode_action(K_CALL))
            acts.extend(self._flush_actions(player))
            return acts
        return acts

    def _flush_actions(self, player: int, include_other: bool = True) -> list[int]:
        """FLUSH_OWN subsets matching the discard top (+ FLUSH_OTHER singles)."""
        acts: list[int] = []
        top = self.discard[-1] if self.discard else None
        if top is None:
            return acts
        trank = rank_of(top)
        matching = [i for i, c in enumerate(self.hands[player]) if c is not None and rank_of(c) == trank]
        # Every single match, plus every multi-subset (TS allows any subset).
        for m in matching:
            acts.append(encode_action(K_FLUSH_OWN, player, 1, m))
        for size in range(2, min(len(matching), 5) + 1):
            combos: list[list[int]] = []
            _subsets(matching, size, [], combos)
            for combo in combos:
                acts.append(encode_action(K_FLUSH_OWN, player, len(combo), *[s for s in combo]))
        if include_other:
            for o in self._others(player):
                for slot in range(len(self.hands[o])):
                    if self.hands[o][slot] is not None:
                        acts.append(encode_action(K_FLUSH_OTHER, player, o, slot))
        return acts

    def action_to_string(self, player: int, action: int) -> str:
        kind, f = decode_action(action)
        name = _KIND_NAMES[kind]
        return f"{name}{f if f else ''}"

    def observation_string(self, player: int) -> str:
        """PRIVATE observation (Phase-2 §3).

        Shows ONLY what this player has legitimately learned plus public
        information. Unknown face-down slots render as '?' — never their
        rank, never their stable id. Opponent hands appear as counts.
        """
        ks = self.knowledge[player]

        def slot(c: int | None) -> str:
            if c is None:
                return "_"
            return card_label(c) if c in ks else "?"

        own = ",".join(slot(c) for c in self.hands[player])
        opp_counts = ",".join(str(self._live(o)) for o in self._others(player))
        top = card_label(self.discard[-1]) if self.discard else "-"
        known = ",".join(card_label(c) for c in sorted(ks))
        drawn = ""
        if (self.phase == PHASE_DRAW_DECISION
                and self.drawn_card is not None
                and player == self.current_turn):
            # The just-drawn card is private to the drawer until resolved.
            drawn = f" drawn={card_label(self.drawn_card)}"
        pp = f" power_pending=p{self.pending_power[0]}:{self.pending_power[1]}" if self.pending_power else ""
        pt = f" transfer=p{self.pending_transfer[0]}->p{self.pending_transfer[1]}" if self.pending_transfer else ""
        scores = ""
        if self.is_terminal():
            scores = " scores=" + ",".join(str(int(x)) for x in self.final_scores)
        return (
            f"phase={self.phase} turn=p{self.current_turn} you=p{player} "
            f"hand=[{own}] opponents=[{opp_counts}] deck={len(self.pool)} "
            f"discard_top={top}{drawn} known={known} cabo={self.cabo_caller}"
            f"{pp}{pt}{scores}"
        )

    def information_state_string(self, player: int) -> str:
        """Perfect-recall information state: private observation plus this
        player's full action/observation history (their decisions carry the
        timing of everything they have ever seen)."""
        return (
            f"{self.observation_string(player)}\n"
            f"your_history={self.history_str()}"
        )

    # -- mutations -----------------------------------------------------------
    def apply_action(self, action: int):
        kind, f = decode_action(action)
        if self.chance_ctx is not None:
            self._apply_chance(int(action))
            return
        me = self.current_player()
        in_window = self.window is not None and kind != K_PASS
        if kind == K_PASS:
            self._window_next()
            return
        if kind == K_PEEK:
            i, j = f
            for idx in (i, j):
                card = self.hands[me][idx]
                assert card is not None
                self._learn(me, card)
            self.initial_peeks_remaining.remove(me)
            if not self.initial_peeks_remaining:
                self.phase = PHASE_TURN_DRAW
            return
        if kind == K_DRAW:
            # §6: card identity is a chance outcome, not an internal draw.
            self._enter_turn_draw_chance(me)
            return
        if kind == K_KEEP:
            drawn = self.drawn_card
            replaced = self.hands[me][f[0]]
            self.hands[me][f[0]] = drawn
            self.drawn_card = None
            self._forget_all(replaced)
            self.discard.append(replaced)
            self._after_discard(me, replaced)
            return
        if kind == K_DISCARD_DRAWN:
            card = self.drawn_card
            self.drawn_card = None
            self._forget_all(card)
            self.discard.append(card)
            self._after_discard(me, card)
            return
        if kind in (K_POWER_PO, K_POWER_PT, K_POWER_BS, K_POWER_SO):
            _, power = self.pending_power
            if kind == K_POWER_PO:
                self._learn(me, self.hands[me][f[0]])
            elif kind == K_POWER_PT:
                o, slot = f
                self._learn(me, self.hands[o][slot])
            elif kind == K_POWER_BS:
                own_slot, o, oslot = f
                a = self.hands[me][own_slot]
                b = self.hands[o][oslot]
                self.hands[me][own_slot] = b
                self.hands[o][oslot] = a
            elif kind == K_POWER_SO:
                sa, sla, sb, slb = f
                ca = self.hands[sa][sla]
                cb = self.hands[sb][slb]
                if (sa, sla) == (sb, slb):
                    raise ValueError("swap card with itself")
                self.hands[sa][sla] = cb
                self.hands[sb][slb] = ca
            self.pending_power = None
            self.phase = PHASE_TURN_DRAW
            self._end_turn_if_active(me)
            return
        if kind == K_FLUSH_OWN:
            actor, n_slots = f[0], f[1]
            slots = list(f[2:])
            top = self.discard[-1]
            mismatches = [
                self.hands[actor][i]
                for i in slots
                if rank_of(self.hands[actor][i]) != rank_of(top)
            ]
            if mismatches:
                for card in mismatches:
                    self._reveal_to_all(card)
                self._wrong_flush_penalty(actor)
                return
            for i in slots:
                card = self.hands[actor][i]
                self.hands[actor][i] = None
                self._forget_all(card)
                self.discard.append(card)
            if in_window and self.window is not None:
                self._window_next()
            return
        if kind == K_FLUSH_OTHER:
            actor, o, slot = f
            card = self.hands[o][slot]
            top = self.discard[-1]
            if rank_of(card) == rank_of(top):
                self.hands[o][slot] = None
                self._forget_all(card)
                self.discard.append(card)
                self.pending_transfer = (actor, o)
                # TS stores the pre-interrupt phase and restores it after transfer.
                self._pre_transfer_phase = self.phase
                self.phase = PHASE_TRANSFER_PENDING
            else:
                self._wrong_flush_penalty(actor)
            if in_window and self.window is not None:
                self._window_next()
            return
        if kind == K_TRANSFER:
            src, dst = self.pending_transfer
            assert src == me
            card = self.hands[src][f[0]]
            self.hands[src][f[0]] = None
            self._place_card(dst, card)
            self.pending_transfer = None
            self.phase = self._pre_transfer_phase
            return
        if kind == K_CALL:
            if self.cabo_caller is not None:
                raise ValueError("cabo already called")
            self.cabo_caller = me
            self.taken_final = []
            self._advance_turn()
            return
        if kind == K_END:
            if self._live(me) == 0 and self.cabo_caller is None:
                self.cabo_caller = me
                self.taken_final = []
                self._advance_turn()
                return
            self.drawn_card = None
            self.phase = PHASE_TURN_END
            self._advance_turn()
            return
        raise ValueError(f"unhandled action kind {kind}")

    def _enter_turn_draw_chance(self, me: int):
        """Turn-draw chance context; recycle discard if the pool is empty."""
        if not self.pool:
            top = self.discard.pop() if self.discard else None
            self.pool = sorted(self.discard)
            self.discard = [top] if top is not None else []
            if not self.pool:
                # Nothing anywhere: keep the game consistent by treating the
                # draw as a pass-through end of turn.
                self.phase = PHASE_TURN_END
                self._open_window(me, PHASE_TURN_END)
                return
        self.chance_ctx = ("draw", me, "turn")

    def _apply_chance(self, card: int):
        ctx = self.chance_ctx
        assert ctx is not None and card in self.pool
        self.pool.remove(card)
        if ctx[0] == "deal":
            seat = ctx[1]
            self.hands[seat].append(card)
            dealt = sum(len(h) for h in self.hands)
            total = 4 * len(self.hands)
            self.chance_ctx = (
                ("deal",) + self._deal_queue[dealt] if dealt < total else None
            )
            return
        who, kind = ctx[1], ctx[2]
        if kind == "turn":
            self.drawn_card = card
            self._learn(who, card)
            self.phase = PHASE_DRAW_DECISION
            self.chance_ctx = None
            return
        # penalty draw: face-down, NOT learned (TS parity)
        self._place_card(who, card)
        post = self._post_penalty
        self._post_penalty = None
        self.chance_ctx = None
        if post is not None and post[0] == "window":
            _, i, queue, resume = post
            if i < len(queue):
                self.window = {"queue": tuple(queue), "i": i, "resume": resume}
            else:
                self.window = None
                self.phase = resume
        elif post is not None:
            self.phase = post[1]

    # ---------- §5 reaction-window machinery -------------------------------
    def _open_window(self, actor: int, resume: str):
        """resolutionOrder (canonical): seats ascending after the actor;
        each live seat takes ONE decision (PASS or a single flush attempt);
        when the pass completes, the suspended phase resumes exactly."""
        n = len(self.hands)
        queue = tuple((actor + k) % n for k in range(1, n)
                      if self._live((actor + k) % n) > 0)
        if queue and self.discard:
            self.window = {"queue": queue, "i": 0, "resume": resume}

    def _window_next(self):
        w = self.window
        assert w is not None
        if w["i"] + 1 < len(w["queue"]):
            w["i"] += 1
        else:
            resume = w["resume"]
            self.window = None
            self.phase = resume

    def _after_discard(self, me: int, card: int):
        power = power_for_rank(rank_of(card))
        if power == "SWAP_OTHERS":
            pass  # disabled in default house rules
        if power == "BLIND_SWAP":
            any_other_live = any(self._live(o) > 0 for o in self._others(me))
            if not any_other_live or self._live(me) == 0:
                power = None
        if power:
            self.pending_power = (me, power)
            self.phase = PHASE_POWER_PENDING
        else:
            self._end_turn_if_active(me)

    def _wrong_flush_penalty(self, me: int):
        """Penalty draws are chance transitions; the card stays secret."""
        if not self.pool:
            if len(self.discard) > 1:
                top = self.discard[-1]
                self.pool = sorted(self.discard[:-1])
                self.discard = [top]
            else:
                return
        if self.window is not None:
            w = self.window
            nxt = min(w["i"] + 1, len(w["queue"]))
            self._post_penalty = ("window", nxt, w["queue"], w["resume"])
            self.window = None
        else:
            self._post_penalty = ("normal", self.phase)
        self.chance_ctx = ("draw", me, "penalty")

    def _end_turn_if_active(self, me: int):
        if me != self.current_turn:
            return
        if self._live(me) == 0 and self.cabo_caller is None:
            self.cabo_caller = me
            self.taken_final = []
            self._advance_turn()
            return
        self.phase = PHASE_TURN_END
        self.drawn_card = None
        self._open_window(me, PHASE_TURN_END)

    def _advance_turn(self):
        n = len(self.hands)
        cabo_caller = self.cabo_caller
        taken = self.taken_final

        def eligible(idx: int) -> bool:
            if self._live(idx) == 0:
                return False
            if cabo_caller is None:
                return True
            if idx == cabo_caller:
                return False  # callerGetsFinalTurn=false
            return taken.count(idx) < 1  # othersFinalTurns=1

        for step in range(1, n + 1):
            cand = (self.current_turn + step) % n
            if cabo_caller is None and self._live(cand) == 0:
                cabo_caller = cand
                self.cabo_caller = cand
                self.taken_final = []
                taken = self.taken_final
                continue
            if eligible(cand):
                self.current_turn = cand
                self.phase = PHASE_TURN_DRAW
                self.drawn_card = None
                if cabo_caller is not None:
                    taken.append(cand)
                return
        self._end_round()

    def _end_round(self):
        self.phase = PHASE_ROUND_COMPLETE
        self.drawn_card = None
        self.pending_power = None
        self.pending_transfer = None
        # TS reveals every remaining hand to everyone at endRound.
        for hand in self.hands:
            for card in hand:
                if card is not None:
                    for ks in self.knowledge:
                        ks.add(card)
        self.final_scores = [
            sum(card_value(c) for c in h if c is not None) for h in self.hands
        ]
        self.scores = list(self.final_scores)
        best = min(self.scores)
        winners = [i for i, v in enumerate(self.scores) if v == best]
        if len(winners) > 1 and self.cabo_caller is not None and self.cabo_caller in winners:
            winners = [self.cabo_caller]
        self.winner = winners[0] if len(winners) == 1 else None


def _subsets(items: list[int], size: int, acc: list[int], out: list[list[int]]):
    if len(acc) == size:
        out.append(list(acc))
        return
    if not items:
        return
    for k, it in enumerate(items):
        acc.append(it)
        _subsets(items[k + 1:], size, acc, out)
        acc.pop()


class CaboGame(pyspiel.Game):
    """Cabo, 2 players, default house rules, seed-parameterised deals."""

    def __init__(self, params: dict | None = None):
        params = params or {}
        game_type = pyspiel.GameType(
            short_name="cabo_research",
            long_name="Cabo (research twin, default house rules)",
            dynamics=pyspiel.GameType.Dynamics.SEQUENTIAL,
            chance_mode=pyspiel.GameType.ChanceMode.DETERMINISTIC,
            information=pyspiel.GameType.Information.IMPERFECT_INFORMATION,
            utility=pyspiel.GameType.Utility.ZERO_SUM,
            reward_model=pyspiel.GameType.RewardModel.TERMINAL,
            max_num_players=2,
            min_num_players=2,
            provides_information_state_string=True,
            provides_information_state_tensor=False,
            provides_observation_string=True,
            provides_observation_tensor=False,
            parameter_specification={"seed": -1},
        )
        game_info = pyspiel.GameInfo(
            num_distinct_actions=13 * 64 ** 3,
            max_chance_outcomes=1,
            num_players=2,
            min_utility=-40.0,
            max_utility=40.0,
            utility_sum=0.0,
            max_game_length=4000,
        )
        super().__init__(game_type, game_info, params)

    def num_players(self):
        return 2

    def max_game_length(self):
        return 4000

    def new_initial_state(self, seed: int | None = None):
        st = CaboState(self)
        if seed is None:
            seed = int(self.get_parameters().get("seed", 1))
        st._reseed_deal(int(seed))
        return st

    def make_py_observer(self, iig_observation_type=None, params=None):
        return None


def register_cabo():
    """Return (game_id, factory) usable with pyspiel.load_game after registration."""
    pyspiel.register_game(_GAME_TYPE_INFO(), CaboGame)
    return "cabo_research"


def _GAME_TYPE_INFO():
    return pyspiel.GameType(
        short_name="cabo_research",
        long_name="Cabo (research twin)",
        dynamics=pyspiel.GameType.Dynamics.SEQUENTIAL,
        chance_mode=pyspiel.GameType.ChanceMode.DETERMINISTIC,
        information=pyspiel.GameType.Information.IMPERFECT_INFORMATION,
        utility=pyspiel.GameType.Utility.ZERO_SUM,
        reward_model=pyspiel.GameType.RewardModel.TERMINAL,
        max_num_players=2,
        min_num_players=2,
        provides_information_state_string=True,
        provides_information_state_tensor=False,
        provides_observation_string=True,
        provides_observation_tensor=False,
        parameter_specification={"seed": -1},
    )
