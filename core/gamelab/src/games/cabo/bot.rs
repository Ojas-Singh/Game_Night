//! A Cabo player written by hand: the opponent the trained player has to beat.
//!
//! It plays careful golf. It keeps a drawn card that beats its worst card,
//! flushes the matches it knows of, looks at and swaps with the hand closest
//! to winning, and calls Cabo when the call is likely to hold up.
//!
//! It uses only what its seat can see: the cards it has looked at, the
//! discard pile, and what the log of the round shows about the other cards.
//! From the log it follows, for every card still in a hand, who knows it and
//! a ceiling on its value: a card kept from the deck was better than the one
//! thrown out for it, and a player who throws a drawn card away holds no card
//! they know to be worse than it. Before calling, it deals the cards it has
//! not seen many times within those ceilings and plays the last round out.
//!
//! This is the same player as `CaboHeuristicBot` on the site
//! (packages/agent-bots), written against the simulation form of the game.

use super::*;

const NO_CAP: i32 = i32::MAX;
/// Deals played out before a call.
const SAMPLES: usize = 300;
/// How often a known match in another hand is flushed.
const FLUSH_OTHER: f32 = 0.92;

/// Chance of winning the round at which a call is worth it, by players left.
fn call_confidence(seats: usize) -> f32 {
    match seats {
        0..=2 => 0.65,
        3 => 0.55,
        _ => 0.45,
    }
}

/// What the table has shown about one card in a hand.
#[derive(Clone, Copy, Debug)]
struct Seen {
    /// Bit per seat that knows the card.
    knowers: u8,
    /// Highest value the card can have.
    cap: i32,
}

const UNSEEN: Seen = Seen { knowers: 0, cap: NO_CAP };

struct Beliefs<'a> {
    game: &'a Cabo,
    me: Seat,
    /// One entry per hand position, as `Cabo::hands`.
    seen: Vec<Vec<Option<Seen>>>,
    /// Cards `me` has not seen: the deck and the unknown cards in hands.
    pool: Vec<Card>,
    mean: f32,
}

fn put(hand: &mut Vec<Option<Seen>>, slot: usize, seen: Seen) {
    if hand.len() <= slot {
        hand.resize(slot + 1, None);
    }
    hand[slot] = Some(seen);
}

impl Cabo {
    /// Who knows each card in a hand and the ceiling on its value, read from the log.
    fn follow_log(&self) -> Vec<Vec<Option<Seen>>> {
        use CaboEvent::*;
        let all = ((1u16 << self.n) - 1) as u8;
        let deck = standard_deck(1);
        let total: i32 = deck.iter().map(|&c| self.rules.card_value(c)).sum();
        let middle = (total as f32 / deck.len() as f32).round() as i32;
        let mut seen = vec![vec![Some(UNSEEN); self.rules.starting_cards as usize]; self.n as usize];
        for e in &self.log {
            match *e {
                Peeked { seat, owner, slot } => {
                    if let Some(Some(s)) = seen[owner as usize].get_mut(slot as usize) {
                        s.knowers |= 1 << seat;
                    }
                }
                Kept { seat, slot, discarded } => {
                    // Kept because it beat the card thrown out, or an unknown card's average.
                    let cap = self.rules.card_value(discarded).max(middle) - 1;
                    put(&mut seen[seat as usize], slot as usize, Seen { knowers: 1 << seat, cap });
                }
                Discarded { seat, card } => {
                    // Thrown away rather than kept: nothing this player knows they hold is worse.
                    let value = self.rules.card_value(card);
                    for s in seen[seat as usize].iter_mut().flatten() {
                        if s.knowers >> seat & 1 == 1 {
                            s.cap = s.cap.min(value);
                        }
                    }
                }
                Swapped { seat, own, target, slot } => {
                    let mine = seen[seat as usize].get(own as usize).copied().flatten().unwrap_or(UNSEEN);
                    let theirs = seen[target as usize].get(slot as usize).copied().flatten().unwrap_or(UNSEEN);
                    put(&mut seen[seat as usize], own as usize, theirs);
                    put(&mut seen[target as usize], slot as usize, mine);
                }
                Flushed { owner, slot, .. } => {
                    if let Some(s) = seen[owner as usize].get_mut(slot as usize) {
                        *s = None;
                    }
                }
                FailedFlushOwn { seat, slot, .. } => {
                    if let Some(Some(s)) = seen[seat as usize].get_mut(slot as usize) {
                        s.knowers = all;
                    }
                }
                Penalty { seat, slot } => put(&mut seen[seat as usize], slot as usize, UNSEEN),
                Transferred { from, from_slot, to, to_slot } => {
                    let moved = seen[from as usize].get_mut(from_slot as usize).and_then(|s| s.take()).unwrap_or(UNSEEN);
                    put(&mut seen[to as usize], to_slot as usize, moved);
                }
                _ => {}
            }
        }
        seen
    }

    fn beliefs(&self, me: Seat) -> Beliefs<'_> {
        let mine = self.known[me as usize];
        let mut out = CardSet::EMPTY;
        out.0 |= self.discard.iter().copied().collect::<CardSet>().0;
        for hand in &self.hands {
            for &c in hand.iter().flatten() {
                if mine.has(c) {
                    out.add(c);
                }
            }
        }
        if let Some(c) = self.drawn.filter(|_| self.turn == me) {
            out.add(c);
        }
        let pool: Vec<Card> = standard_deck(1).into_iter().filter(|&c| !out.has(c)).collect();
        let mean = if pool.is_empty() {
            6.5
        } else {
            pool.iter().map(|&c| self.rules.card_value(c)).sum::<i32>() as f32 / pool.len() as f32
        };
        Beliefs { game: self, me, seen: self.follow_log(), pool, mean }
    }
}

impl Beliefs<'_> {
    fn value(&self, c: Card) -> i32 {
        self.game.rules.card_value(c)
    }

    fn seen(&self, seat: Seat, slot: usize) -> Seen {
        self.seen[seat as usize].get(slot).copied().flatten().unwrap_or(UNSEEN)
    }

    fn i_know(&self, c: Card) -> bool {
        self.game.known[self.me as usize].has(c)
    }

    /// Expected value of the card at a hand position.
    fn expected(&self, seat: Seat, slot: usize) -> f32 {
        let Some(c) = self.game.hands[seat as usize][slot] else { return 0.0 };
        if self.i_know(c) {
            return self.value(c) as f32;
        }
        let cap = self.seen(seat, slot).cap;
        if cap == NO_CAP {
            return self.mean;
        }
        let under: Vec<i32> = self.pool.iter().map(|&c| self.value(c)).filter(|&v| v <= cap).collect();
        if under.is_empty() {
            (cap as f32).min(self.mean)
        } else {
            under.iter().sum::<i32>() as f32 / under.len() as f32
        }
    }

    fn slots(&self, seat: Seat) -> impl Iterator<Item = usize> + '_ {
        let hand = &self.game.hands[seat as usize];
        (0..hand.len()).filter(move |&i| hand[i].is_some())
    }

    fn hand_value(&self, seat: Seat) -> f32 {
        self.slots(seat).map(|i| self.expected(seat, i)).sum()
    }

    /// The position of the seat's highest card, as far as `me` can tell.
    fn worst(&self, seat: Seat) -> Option<(usize, f32)> {
        let mut worst: Option<(usize, f32)> = None;
        for i in self.slots(seat) {
            let v = self.expected(seat, i);
            if worst.map_or(true, |w| v > w.1) {
                worst = Some((i, v));
            }
        }
        worst
    }

    fn others(&self) -> impl Iterator<Item = Seat> + '_ {
        (0..self.game.n).filter(move |&p| p != self.me && self.game.live_count(p) > 0)
    }

    /// Chance that `me` ends with the lowest hand after calling Cabo now. The
    /// unseen cards are dealt within their ceilings and every other player
    /// takes one turn as a careful player does: keep the drawn card when it
    /// beats the worst card they know of, drop a card matching a discard, and
    /// use a swap to hand the caller their worst card.
    fn chance_call_wins(&self, rng: &mut Rng) -> f32 {
        #[derive(Clone, Copy)]
        struct Dealt {
            card: Card,
            value: i32,
            /// Its holder knows what it is.
            known: bool,
        }
        let g = self.game;
        let order: Vec<Seat> =
            (0..g.n).map(|i| (self.me + i) % g.n).filter(|&p| p == self.me || g.live_count(p) > 0).collect();
        let mut fixed: Vec<Vec<Dealt>> = vec![Vec::new(); order.len()];
        // Cards to deal, the most restricted first so that their ceilings can be met.
        let mut unknown: Vec<(usize, i32, bool)> = Vec::new();
        for (at, &p) in order.iter().enumerate() {
            for i in self.slots(p) {
                let c = g.hands[p as usize][i].unwrap();
                let seen = self.seen(p, i);
                let known = g.known[p as usize].has(c);
                if self.i_know(c) {
                    fixed[at].push(Dealt { card: c, value: self.value(c), known });
                } else {
                    unknown.push((at, seen.cap, known));
                }
            }
        }
        unknown.sort_by_key(|u| u.1);

        fn take(pool: &mut Vec<Card>, cap: i32, rules: &CaboRules, rng: &mut Rng) -> Option<Card> {
            if pool.is_empty() {
                return None;
            }
            let (mut pick, mut count) = (usize::MAX, 0);
            for (i, &c) in pool.iter().enumerate() {
                if rules.card_value(c) <= cap {
                    count += 1;
                    if rng.int(count) == 0 {
                        pick = i;
                    }
                }
            }
            if pick == usize::MAX {
                pick = rng.int(pool.len());
            }
            Some(pool.swap_remove(pick))
        }

        let mut wins = 0;
        let mut pool = Vec::with_capacity(self.pool.len());
        for _ in 0..SAMPLES {
            pool.clear();
            pool.extend_from_slice(&self.pool);
            let mut hands = fixed.clone();
            for &(at, cap, known) in &unknown {
                if let Some(card) = take(&mut pool, cap, &g.rules, rng) {
                    hands[at].push(Dealt { card, value: self.value(card), known });
                }
            }
            for seat in 1..hands.len() {
                if hands[seat].is_empty() {
                    continue;
                }
                let Some(drawn) = take(&mut pool, NO_CAP, &g.rules, rng) else { break };
                let guess = |c: &Dealt| if c.known { c.value as f32 } else { self.mean };
                let mut worst = 0;
                for i in 1..hands[seat].len() {
                    if guess(&hands[seat][i]) > guess(&hands[seat][worst]) {
                        worst = i;
                    }
                }
                let value = self.value(drawn);
                let thrown;
                if (value as f32) < guess(&hands[seat][worst]) {
                    thrown = hands[seat][worst].card;
                    hands[seat][worst] = Dealt { card: drawn, value, known: true };
                } else {
                    thrown = drawn;
                    if g.rules.power(drawn) == Power::BlindSwap && !hands[0].is_empty() {
                        let mine = rng.int(hands[0].len());
                        let given = hands[seat][worst];
                        hands[seat][worst] = Dealt { known: false, ..hands[0][mine] };
                        hands[0][mine] = Dealt { known: false, ..given };
                    }
                }
                // Anyone still to play, or who has just played, drops a known match.
                for hand in hands.iter_mut().skip(1) {
                    if let Some(at) = hand.iter().position(|c| c.known && c.card.rank() == thrown.rank() && c.value >= 0) {
                        hand.remove(at);
                    }
                }
            }
            let totals: Vec<i32> = hands.iter().map(|h| h.iter().map(|c| c.value).sum()).collect();
            // The caller wins a tie.
            if totals[0] == *totals.iter().min().unwrap() {
                wins += 1;
            }
        }
        wins as f32 / SAMPLES as f32
    }
}

/// The item with the lowest key; ties are broken at random.
fn lowest<T: Copy>(items: impl Iterator<Item = (T, f32)>, rng: &mut Rng) -> Option<T> {
    let mut best: Option<(T, f32)> = None;
    let mut ties = 0;
    for (item, key) in items {
        match best {
            Some((_, b)) if key > b => {}
            Some((_, b)) if key == b => {
                ties += 1;
                if rng.int(ties) == 0 {
                    best = Some((item, key));
                }
            }
            _ => {
                best = Some((item, key));
                ties = 1;
            }
        }
    }
    best.map(|b| b.0)
}

impl Cabo {
    /// The move of the hand-written player for the seat to act, in simulation
    /// form. `None` when the round is over.
    pub fn bot_action(&self, rng: &mut Rng) -> Option<CaboAction> {
        use CaboAction::*;
        let me = self.to_act()?;
        let b = self.beliefs(me);
        let hand = &self.hands[me as usize];

        if self.payer().is_some() {
            return b.worst(me).map(|(slot, _)| Transfer { slot: slot as u8 });
        }

        if !self.react.is_empty() {
            let Some(&top) = self.discard.last() else { return Some(Pass) };
            let matches = |c: Card| b.i_know(c) && c.rank() == top.rank();
            if self.rules.flush_own {
                // A card worth less than nothing is better kept.
                let own = b.slots(me).find(|&i| matches(hand[i].unwrap()) && b.value(hand[i].unwrap()) >= 0);
                if let Some(slot) = own.filter(|&i| i < MAX_SLOTS) {
                    return Some(FlushOwn { slots: 1 << slot });
                }
            }
            if self.rules.flush_other && rng.next_f32() < FLUSH_OTHER {
                // Take a card from the hand closest to winning.
                let hits = b.others().filter_map(|p| {
                    let slot = b.slots(p).find(|&i| matches(self.hands[p as usize][i].unwrap()))?;
                    Some(((p, slot), b.hand_value(p)))
                });
                if let Some((target, slot)) = lowest(hits, rng) {
                    return Some(FlushOther { target, slot: slot as u8 });
                }
            }
            return Some(Pass);
        }

        match self.phase {
            Phase::InitialPeek => {
                // The bottom row first, as people do at the table.
                let unknown = |i: &usize| hand.get(*i).copied().flatten().is_some_and(|c| !b.i_know(c));
                let slot = [1, 3].into_iter().find(unknown).or_else(|| (0..hand.len()).find(unknown))?;
                Some(PeekStarting { slots: 1 << slot })
            }
            Phase::TurnDraw => Some(Draw),
            Phase::DrawDecision => {
                let drawn = self.drawn?;
                match b.worst(me) {
                    Some((slot, value)) if (b.value(drawn) as f32) < value => Some(Keep { slot: slot as u8 }),
                    _ => Some(DiscardDrawn),
                }
            }
            Phase::PowerPending => match self.pending_power?.0 {
                Power::PeekOwn => {
                    let unknown = b.slots(me).find(|&i| !b.i_know(hand[i].unwrap()));
                    let slot = unknown.or_else(|| b.worst(me).map(|w| w.0))?;
                    Some(PeekOwn { slot: slot as u8 })
                }
                Power::PeekOther => {
                    // Look where it matters: the hand closest to winning, at a card not yet seen.
                    let unseen = |p: Seat, i: usize| !b.i_know(self.hands[p as usize][i].unwrap());
                    let with_unseen = b.others().filter(|&p| b.slots(p).any(|i| unseen(p, i)));
                    let target = lowest(with_unseen.map(|p| (p, b.hand_value(p))), rng)
                        .or_else(|| lowest(b.others().map(|p| (p, b.hand_value(p))), rng))?;
                    let slot = lowest(b.slots(target).map(|i| (i, if unseen(target, i) { 0.0 } else { 1.0 })), rng)?;
                    Some(PeekOther { target, slot: slot as u8 })
                }
                Power::BlindSwap => {
                    // Give the worst card for the lowest card any other hand holds.
                    let (own, _) = b.worst(me)?;
                    let cards = b.others().flat_map(|p| b.slots(p).map(move |i| (p, i)));
                    let (target, slot) = lowest(cards.map(|(p, i)| ((p, i), b.expected(p, i))), rng)?;
                    Some(BlindSwap { own: own as u8, target, slot: slot as u8 })
                }
                Power::None => None,
            },
            Phase::TurnEnd => {
                if self.rules.cabo_enabled && self.cabo.is_none() {
                    let seats = 1 + b.others().count();
                    if b.chance_call_wins(rng) >= call_confidence(seats) {
                        return Some(CallCabo);
                    }
                }
                Some(EndTurn)
            }
            Phase::Complete => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One round between the hand-written player (in the seats of `bots`)
    /// and random play.
    fn round(seed: u32, players: usize, bots: u8, checks: bool) -> Cabo {
        let rules = CaboRules { turn_limit: 200, ..CaboRules::default() };
        let mut g = Cabo::deal(&rules, players, Rng::new(seed), true).unwrap();
        let mut rng = Rng::new(seed ^ 0x5eed);
        let mut legal = Vec::new();
        while let Some(seat) = g.to_act() {
            g.legal_actions(&mut legal);
            let action = if bots >> seat & 1 == 1 {
                let a = g.bot_action(&mut rng).expect("the bot always has a move");
                assert!(legal.contains(&a), "{a:?} is not among {legal:?}");
                a
            } else if legal[0] == CaboAction::Pass && rng.int(4) > 0 {
                // Mostly decline to flush, or random play is all penalty cards.
                legal[0]
            } else {
                legal[rng.int(legal.len())]
            };
            g.apply(seat, &action).unwrap();
            if checks && g.phase != Phase::Complete {
                // What the log says each seat knows is what the game says.
                let seen = g.follow_log();
                for p in 0..g.n as usize {
                    for (i, c) in g.hands[p].iter().enumerate() {
                        let logged = seen[p].get(i).copied().flatten();
                        assert_eq!(logged.is_some(), c.is_some(), "seat {p} slot {i} after {action:?}");
                        if let (Some(s), Some(c)) = (logged, c) {
                            assert_eq!(s.knowers, g.knowers(*c), "seat {p} slot {i} after {action:?}");
                        }
                    }
                }
            }
        }
        g
    }

    #[test]
    fn the_log_tells_who_knows_each_card() {
        for seed in 0..200 {
            round(seed, 2 + seed as usize % 4, if seed % 2 == 0 { 0b111111 } else { 0b010101 }, true);
        }
    }

    #[test]
    fn the_bot_beats_random_play_and_its_calls_hold_up() {
        let (mut wins, mut calls, mut held) = (0.0, 0, 0);
        let rounds = 400;
        for seed in 0..rounds {
            let g = round(1000 + seed, 2, 1 << (seed % 2), false);
            let result = g.result.as_ref().unwrap();
            let me = (seed % 2) as Seat;
            if result.winners.contains(&me) {
                wins += 1.0 / result.winners.len() as f32;
            }
            if g.log.iter().any(|e| *e == (CaboEvent::CaboCalled { seat: me, auto: false })) {
                calls += 1;
                held += result.winners.contains(&me) as u32;
            }
        }
        assert!(wins > 0.75 * rounds as f32, "won {wins} of {rounds}; {held} of {calls} calls held");
        assert!(calls > rounds / 2 && held as f32 > 0.8 * calls as f32, "{held} of {calls} calls held");
    }
}
