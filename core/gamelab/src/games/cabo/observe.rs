//! Cabo as the lab and the model see it: rule settings, observations and
//! re-dealing of hidden cards.

use super::*;
use crate::obs::{field, game_code, kind, rel, rel_mask, zone, ActionToken, Obs, Token};
use crate::settings::{Choice, Setting, SettingKind};

const G: u16 = 1;

/// What the observer is being asked to decide (global token, `SLOT` field).
#[derive(Clone, Copy)]
enum Decision {
    Waiting = 1,
    InitialPeek,
    Draw,
    KeepOrDiscard,
    PeekOwn,
    PeekOther,
    BlindSwap,
    EndTurn,
    FlushOrPass,
    HandOver,
    Over,
}

mod verb {
    pub const PEEK_STARTING: u16 = 1;
    pub const DRAW: u16 = 2;
    pub const KEEP: u16 = 3;
    pub const DISCARD_DRAWN: u16 = 4;
    pub const PEEK_OWN: u16 = 5;
    pub const PEEK_OTHER: u16 = 6;
    pub const BLIND_SWAP: u16 = 7;
    pub const FLUSH_OWN: u16 = 8;
    pub const FLUSH_OTHER: u16 = 9;
    pub const TRANSFER: u16 = 10;
    pub const CALL_CABO: u16 = 11;
    pub const END_TURN: u16 = 12;
    pub const PASS: u16 = 13;
}

/// `SUB` codes of event tokens start here, rule tokens after them.
const EVENT_BASE: u16 = 1;
const RULE_BASE: u16 = 20;
/// Rule token carrying one rank's points and power.
const RULE_RANK: u16 = RULE_BASE + 15;

/// Most recent events shown to the model.
const HISTORY: usize = 32;

impl CaboRules {
    fn scalar_tokens(&self) -> [i32; 11] {
        [
            self.starting_cards as i32,
            self.initial_peek_cards as i32,
            self.wrong_flush_penalty as i32,
            self.flush_own as i32,
            self.flush_other as i32,
            self.reshuffle_discard as i32,
            self.end_round_when_player_out as i32,
            self.cabo_enabled as i32,
            self.caller_gets_final_turn as i32,
            self.others_final_turns as i32,
            (self.turn_limit as i32 + 7) / 8,
        ]
    }
}

impl Cabo {
    fn decision(&self, me: Seat) -> Decision {
        if self.phase == Phase::Complete {
            return Decision::Over;
        }
        // In live mode nobody is "to act" for flushes; the turn player still is.
        if self.to_act() != Some(me) {
            return Decision::Waiting;
        }
        if self.payer().is_some() {
            return Decision::HandOver;
        }
        if !self.react.is_empty() {
            return Decision::FlushOrPass;
        }
        match self.phase {
            Phase::InitialPeek => Decision::InitialPeek,
            Phase::TurnDraw => Decision::Draw,
            Phase::DrawDecision => Decision::KeepOrDiscard,
            Phase::PowerPending => match self.pending_power.map(|p| p.0) {
                Some(Power::PeekOwn) => Decision::PeekOwn,
                Some(Power::PeekOther) => Decision::PeekOther,
                _ => Decision::BlindSwap,
            },
            Phase::TurnEnd => Decision::EndTurn,
            Phase::Complete => Decision::Over,
        }
    }

    /// Seats that know `card`, as a bit per absolute seat.
    fn knowers(&self, card: Card) -> u8 {
        (0..self.n).filter(|&p| self.known[p as usize].has(card)).fold(0, |m, p| m | 1 << p)
    }

    fn card_token(&self, me: Seat, omniscient: bool, zone: u16, owner: Seat, card: Card) -> Token {
        let n = self.n;
        let mut t = Token::new(kind::CARD, zone).seat(rel(me, owner, n)).flags(rel_mask(me, self.knowers(card), n));
        if omniscient || self.known[me as usize].has(card) {
            t = self.shown(t, card);
        }
        t
    }

    /// A face-up card with its points and power under the rules in force.
    fn shown(&self, t: Token, card: Card) -> Token {
        t.face(card).value(self.rules.card_value(card)).aux(self.rules.power(card) as usize + 1)
    }

    fn event_token(&self, me: Seat, e: &CaboEvent, age: usize) -> Token {
        use CaboEvent::*;
        let n = self.n;
        let r = |s: Seat| rel(me, s, n);
        let ev = |i: u16, seat: Seat| Token::new(kind::EVENT, game_code(G, EVENT_BASE + i)).seat(r(seat)).aux(age);
        match *e {
            TurnStarted { seat } => ev(0, seat),
            Peeked { seat, owner, slot } => ev(1, seat).seat2(r(owner)).slot(slot as usize),
            Drew { seat } => ev(2, seat),
            Kept { seat, slot, discarded } => ev(3, seat).slot(slot as usize).face(discarded),
            Discarded { seat, card } => ev(4, seat).face(card),
            // The second position travels in the value field.
            Swapped { seat, own, target, slot } => ev(5, seat).slot(own as usize).seat2(r(target)).value(slot as i32),
            Flushed { seat, owner, slot, card } => ev(6, seat).seat2(r(owner)).slot(slot as usize).face(card),
            FailedFlushOwn { seat, slot, card } => ev(7, seat).slot(slot as usize).face(card),
            FailedFlushOther { seat, target, slot } => ev(8, seat).seat2(r(target)).slot(slot as usize),
            Penalty { seat, slot } => ev(9, seat).slot(slot as usize),
            Transferred { from, from_slot, to, to_slot } => {
                ev(10, from).slot(from_slot as usize).seat2(r(to)).value(to_slot as i32)
            }
            CaboCalled { seat, auto } => ev(11, seat).flags(auto as u16),
            Reshuffled => Token::new(kind::EVENT, game_code(G, EVENT_BASE + 12)).aux(age),
        }
    }

    pub(super) fn observe(&self, me: Seat, omniscient: bool, obs: &mut Obs) {
        obs.clear();
        let n = self.n;
        let r = |s: Seat| rel(me, s, n);
        let rules = &self.rules;

        // The table.
        let mut global = Token::new(kind::GLOBAL, game_code(G, 0))
            .seat(r(self.turn))
            .flags(self.cabo.is_some() as u16 | (!self.transfers.is_empty() as u16) << 1 | (self.sim as u16) << 2)
            .aux(self.turns_started as usize);
        global.0[field::SLOT] = self.decision(me) as u16;
        global.0[field::RANK] = n as u16;
        if let Some(c) = &self.cabo {
            global = global.seat2(r(c.caller));
        }
        if rules.turn_limit > 0 {
            global = global.value(rules.turn_limit.saturating_sub(self.turns_started) as i32);
        }
        obs.push(global);

        // Players.
        for p in 0..n {
            let caller = self.cabo.as_ref().is_some_and(|c| c.caller == p);
            let flags = (p == self.turn) as u16
                | (caller as u16) << 1
                | (self.transfers.iter().any(|t| t.from == p) as u16) << 2
                | ((self.peeks_remaining >> p & 1) as u16) << 3
                | ((self.to_act() == Some(p)) as u16) << 4;
            let mut t = Token::new(kind::PLAYER, 0).seat(r(p)).flags(flags).aux(self.live_count(p));
            if let Some(c) = &self.cabo {
                t = t.value(c.taken[p as usize] as i32);
            }
            obs.push(t);
        }

        // Cards on the table.
        let mut at: Vec<Vec<u16>> = self.hands.iter().map(|h| vec![crate::obs::NO_ARG; h.len()]).collect();
        for p in 0..n {
            for (i, c) in self.hands[p as usize].iter().enumerate() {
                if let Some(c) = *c {
                    let t = self.card_token(me, omniscient, zone::HAND, p, c).slot(i);
                    at[p as usize][i] = obs.push(t) as u16;
                }
            }
        }
        let mut drawn_at = 0;
        if let Some(c) = self.drawn {
            drawn_at = obs.push(self.card_token(me, omniscient, zone::DRAWN, self.turn, c));
        }
        if let Some(&top) = self.discard.last() {
            obs.push(self.shown(Token::new(kind::CARD, zone::DISCARD_TOP), top));
        }

        // Piles.
        obs.push(Token::new(kind::PILE, zone::DECK).aux(self.deck.len()));
        let mut by_rank = [0usize; 13];
        for c in &self.discard {
            by_rank[c.rank() as usize - 1] += 1;
        }
        for (i, &count) in by_rank.iter().enumerate() {
            if count > 0 {
                obs.push(Token::new(kind::PILE, zone::DISCARD).rank(i as u8 + 1).aux(count));
            }
        }

        // Recent events, newest first.
        for (age, e) in self.log.iter().rev().take(HISTORY).enumerate() {
            obs.push(self.event_token(me, e, age));
        }

        // The rules in force.
        for (i, v) in rules.scalar_tokens().into_iter().enumerate() {
            obs.push(Token::new(kind::RULE, game_code(G, RULE_BASE + i as u16)).value(v));
        }
        for rank in 1..=12u8 {
            let i = rank as usize - 1;
            obs.push(
                Token::new(kind::RULE, game_code(G, RULE_RANK))
                    .rank(rank)
                    .value(rules.rank_values[i] as i32)
                    .aux(rules.rank_powers[i] as usize + 1),
            );
        }
        // Kings score by colour: suit 1 stands for black, 2 for red.
        for (suit, value) in [(1, rules.black_king_value), (2, rules.red_king_value)] {
            obs.push(
                Token::new(kind::RULE, game_code(G, RULE_RANK))
                    .rank(13)
                    .suit(suit)
                    .value(value as i32)
                    .aux(rules.rank_powers[12] as usize + 1),
            );
        }

        // The observer's options.
        if self.sim && self.to_act() == Some(me) {
            let mut legal = Vec::new();
            self.legal_actions(&mut legal);
            let a = |v: u16| ActionToken::new(game_code(G, v));
            let mine = |slot: u8| at[me as usize][slot as usize] as usize;
            let theirs = |target: Seat, slot: u8| at[target as usize][slot as usize] as usize;
            for action in legal {
                use CaboAction::*;
                obs.actions.push(match action {
                    PeekStarting { slots } => a(verb::PEEK_STARTING).arg(0, mine(slots.trailing_zeros() as u8)),
                    Draw => a(verb::DRAW),
                    Keep { slot } => a(verb::KEEP).arg(0, mine(slot)).arg(1, drawn_at),
                    DiscardDrawn => a(verb::DISCARD_DRAWN).arg(0, drawn_at),
                    PeekOwn { slot } => a(verb::PEEK_OWN).arg(0, mine(slot)),
                    PeekOther { target, slot } => a(verb::PEEK_OTHER).arg(0, theirs(target, slot)),
                    BlindSwap { own, target, slot } => {
                        a(verb::BLIND_SWAP).arg(0, mine(own)).arg(1, theirs(target, slot))
                    }
                    FlushOwn { slots } => a(verb::FLUSH_OWN).arg(0, mine(slots.trailing_zeros() as u8)),
                    FlushOther { target, slot } => a(verb::FLUSH_OTHER).arg(0, theirs(target, slot)),
                    Transfer { slot } => a(verb::TRANSFER).arg(0, mine(slot)),
                    CallCabo => a(verb::CALL_CABO),
                    EndTurn => a(verb::END_TURN),
                    Pass => a(verb::PASS),
                });
            }
        }
    }

    pub(super) fn determinize(&self, me: Seat, rng: &mut Rng) -> Cabo {
        let mut g = self.clone();
        g.rng = rng.fork();
        g.react_rng = rng.fork();
        if self.phase == Phase::Complete {
            return g;
        }
        let mine = self.known[me as usize];

        // Every card `me` has not seen: the deck, face-down cards and another
        // player's drawn card. They are dealt again among the same positions.
        let mut pool: Vec<Card> = Vec::with_capacity(52);
        pool.extend(g.deck.iter().filter(|c| !mine.has(**c)));
        pool.extend(g.hands.iter().flatten().flatten().filter(|c| !mine.has(**c)));
        pool.extend(g.drawn.iter().filter(|c| !mine.has(**c)));
        let before = pool.clone();
        rng.shuffle(&mut pool);

        let mut next = pool.iter().copied();
        for c in g.deck.iter_mut().chain(g.hands.iter_mut().flatten().flatten()).chain(g.drawn.iter_mut()) {
            if !mine.has(*c) {
                *c = next.next().unwrap();
            }
        }

        // The other players still know the cards they looked at: their
        // knowledge follows the positions, not the old identities.
        let mut now = [0u8; 128];
        for (old, new) in before.iter().zip(&pool) {
            now[old.0 as usize] = new.0 + 1;
        }
        for (p, k) in g.known.iter_mut().enumerate() {
            if p != me as usize {
                *k = k.iter().map(|c| if now[c.0 as usize] > 0 { Card(now[c.0 as usize] - 1) } else { c }).collect();
            }
        }

        // The order in which the remaining seats are asked is not known either.
        let asked = if self.payer().is_none() && !g.react.is_empty() { 1 } else { 0 };
        if g.react.len() > asked {
            g.react_rng.shuffle(&mut g.react[asked..]);
        }
        g
    }

    pub fn settings() -> Vec<Setting> {
        let powers = vec![
            Choice { value: json!("NONE"), label: "No power" },
            Choice { value: json!("PEEK_OWN"), label: "Peek at own card" },
            Choice { value: json!("PEEK_OTHER"), label: "Peek at another player's card" },
            Choice { value: json!("BLIND_SWAP"), label: "Blind swap" },
        ];
        let (deal, cards, flush, end) = ("Deal", "Cards", "Flushing", "Ending the round");
        vec![
            Setting::int(deal, "startingCards", "Cards per player", "Cards dealt face-down to each player.", 1, 8),
            Setting::int(
                deal,
                "initialPeekCards",
                "Cards looked at before play",
                "How many of their own cards each player looks at first.",
                0,
                8,
            ),
            Setting::rank_ints(cards, "rankValues", "Points per rank", "Ace to queen; kings are set below.", -5, 15),
            Setting::int(cards, "redKingValue", "Red king points", "", -5, 15),
            Setting::int(cards, "blackKingValue", "Black king points", "", -5, 15),
            Setting {
                key: "rankPowers",
                label: "Power per rank",
                help: "What a player may do when a card of this rank reaches the discard pile on their turn.",
                group: cards,
                kind: SettingKind::RankChoices { options: powers },
            },
            Setting::bool(flush, "flushOwn", "Flush own cards", "Players may flush their own matching cards."),
            Setting::bool(
                flush,
                "flushOther",
                "Flush other players' cards",
                "Players may flush another player's matching card and hand over one of their own.",
            ),
            Setting::int(flush, "wrongFlushPenalty", "Penalty cards for a wrong flush", "", 0, 2),
            Setting::bool(
                end,
                "reshuffleDiscard",
                "Reshuffle when the deck runs out",
                "Otherwise the round ends when the deck is empty.",
            ),
            Setting::bool(
                end,
                "endRoundWhenPlayerOut",
                "End when a player has no cards",
                "The round ends at once when any player has no cards left.",
            ),
            Setting::bool(end, "caboEnabled", "Players can call Cabo", ""),
            Setting::bool(
                end,
                "callerGetsFinalTurn",
                "Caller plays a final turn",
                "The player who called Cabo gets one more turn.",
            ),
            Setting::int(end, "othersFinalTurns", "Final turns for the others", "Turns each other player gets after the call.", 1, 3),
            Setting::int(end, "turnLimit", "Turn limit", "End the round after this many turns; 0 for no limit.", 0, 1000),
        ]
    }
}

impl Game for Cabo {
    const ID: &'static str = "cabo";
    const NUMBER: u16 = G;
    const PLAYERS: (usize, usize) = (2, 6);
    type Rules = CaboRules;
    type Action = CaboAction;

    fn new(rules: &CaboRules, players: usize, rng: Rng) -> Result<Self, String> {
        Cabo::deal(rules, players, rng, true)
    }
    fn live(rules: &CaboRules, players: usize, rng: Rng) -> Result<Self, String> {
        Cabo::deal(rules, players, rng, false)
    }
    fn players(&self) -> usize {
        self.n as usize
    }
    fn is_over(&self) -> bool {
        self.phase == Phase::Complete
    }
    fn to_act(&self) -> Option<Seat> {
        Cabo::to_act(self)
    }
    fn legal_actions(&self, out: &mut Vec<CaboAction>) {
        Cabo::legal_actions(self, out)
    }
    fn apply(&mut self, seat: Seat, action: &CaboAction) -> Result<(), Illegal> {
        Cabo::apply(self, seat, action)
    }
    fn returns(&self) -> Vec<f32> {
        match &self.result {
            Some(r) => winner_returns(self.n as usize, &r.winners),
            None => vec![0.0; self.n as usize],
        }
    }
    fn settings() -> Vec<Setting> {
        Cabo::settings()
    }
    fn verbs() -> Vec<(u16, &'static str)> {
        vec![
            (verb::PEEK_STARTING, "Look at a starting card"),
            (verb::DRAW, "Draw"),
            (verb::KEEP, "Keep the drawn card"),
            (verb::DISCARD_DRAWN, "Discard the drawn card"),
            (verb::PEEK_OWN, "Peek at an own card"),
            (verb::PEEK_OTHER, "Peek at another player's card"),
            (verb::BLIND_SWAP, "Swap blind"),
            (verb::FLUSH_OWN, "Flush an own card"),
            (verb::FLUSH_OTHER, "Flush another player's card"),
            (verb::TRANSFER, "Hand over a card"),
            (verb::CALL_CABO, "Call Cabo"),
            (verb::END_TURN, "End the turn"),
            (verb::PASS, "Decline to flush"),
        ]
    }
    fn stat_names() -> Vec<crate::game::Stat> {
        use crate::game::Stat;
        vec![
            Stat::new("turns", "Turns"),
            Stat::new("called", "A player called Cabo"),
            Stat::new("callerWon", "The caller won"),
            Stat::new("callerScore", "Hand total of the caller"),
            Stat::new("winningScore", "Winning hand total"),
            Stat::new("meanScore", "Mean hand total"),
            Stat::new("flushes", "Cards flushed"),
            Stat::new("failedFlushes", "Failed flushes"),
            Stat::new("swaps", "Blind swaps"),
            Stat::new("peeks", "Peeks with a card's power"),
            Stat::new("reshuffles", "Reshuffles of the discard pile"),
            Stat::new("tied", "Tied for the lowest total"),
        ]
    }
    fn stats(&self) -> Vec<f32> {
        let Some(result) = &self.result else { return vec![f32::NAN; 12] };
        let count = |f: fn(&CaboEvent) -> bool| self.log.iter().filter(|e| f(e)).count() as f32;
        // Looking at the starting cards is logged as a peek at an own card
        // before the first turn; only peeks after it are powers.
        let first_turn = self.log.iter().position(|e| matches!(e, CaboEvent::TurnStarted { .. })).unwrap_or(0);
        let peeks = self.log[first_turn..].iter().filter(|e| matches!(e, CaboEvent::Peeked { .. })).count();
        let called = self.log.iter().any(|e| matches!(e, CaboEvent::CaboCalled { auto: false, .. }));
        let caller = self.cabo.as_ref().filter(|_| called).map(|c| c.caller);
        let best = *result.scores.iter().min().unwrap();
        vec![
            self.turns_started as f32,
            called as u8 as f32,
            caller.map_or(f32::NAN, |c| result.winners.contains(&c) as u8 as f32),
            caller.map_or(f32::NAN, |c| result.scores[c as usize] as f32),
            best as f32,
            result.scores.iter().sum::<i32>() as f32 / self.n as f32,
            count(|e| matches!(e, CaboEvent::Flushed { .. })),
            count(|e| matches!(e, CaboEvent::FailedFlushOwn { .. } | CaboEvent::FailedFlushOther { .. })),
            count(|e| matches!(e, CaboEvent::Swapped { .. })),
            peeks as f32,
            count(|e| matches!(e, CaboEvent::Reshuffled)),
            (result.scores.iter().filter(|&&s| s == best).count() > 1) as u8 as f32,
        ]
    }
    fn observe(&self, seat: Seat, omniscient: bool, obs: &mut Obs) {
        Cabo::observe(self, seat, omniscient, obs)
    }
    fn determinize(&self, seat: Seat, rng: &mut Rng) -> Self {
        Cabo::determinize(self, seat, rng)
    }
    fn for_seat(&self, seat: Seat, reacting: bool, rng: &mut Rng) -> Option<Self> {
        Cabo::for_seat(self, seat, reacting, rng)
    }
    fn at_table(&self, seat: Seat, action: &CaboAction) -> AtTable<CaboAction> {
        Cabo::at_table(self, seat, action)
    }
}
