//! Cabo (house rules): keep the lowest total of face-down cards.
//!
//! On your turn you draw, then either keep the drawn card in place of one of
//! yours or discard it; the card that reaches the discard pile triggers its
//! power (peek at your own card, peek at another player's, blind swap). At any
//! moment any player may *flush* a card that matches the top of the discard
//! pile: their own, or another player's (they then hand that player one of
//! their own cards). A wrong flush costs a penalty card. A player ends their
//! turn by passing or by calling Cabo, which gives everyone else their final
//! turns before the reveal.
//!
//! Flushing is a race on the live site. In simulation mode the race is made
//! explicit: whenever the top of the discard pile changes, every seat is asked
//! once, in random order, whether to flush or pass; a seat that has just
//! peeked at a card is asked too.

use crate::cards::{standard_deck, Card, CardSet};
use crate::game::{winner_returns, AtTable, Game, Illegal, Seat};
use crate::rng::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

mod observe;

/// Hand positions are addressed by bit masks in some actions.
pub const MAX_SLOTS: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Power {
    None,
    /// Look at one of your own cards.
    PeekOwn,
    /// Look at one card of another player.
    PeekOther,
    /// Swap one of your cards with another player's, without looking.
    BlindSwap,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CaboRules {
    /// Cards dealt face-down to each player.
    pub starting_cards: u8,
    /// How many of their own cards a player looks at before play starts.
    pub initial_peek_cards: u8,
    /// Points per rank, ace first. Kings use the two values below.
    pub rank_values: [i8; 13],
    pub red_king_value: i8,
    pub black_king_value: i8,
    /// Power carried by each rank, ace first.
    pub rank_powers: [Power; 13],
    /// Cards drawn as the penalty for a wrong flush (0 to 2).
    pub wrong_flush_penalty: u8,
    /// Players may flush their own matching cards.
    pub flush_own: bool,
    /// Players may flush other players' matching cards.
    pub flush_other: bool,
    /// When the deck runs out: reshuffle the discard pile (true) or end the round.
    pub reshuffle_discard: bool,
    /// End the round as soon as any player has no cards.
    pub end_round_when_player_out: bool,
    pub cabo_enabled: bool,
    /// The caller plays one more turn after calling.
    pub caller_gets_final_turn: bool,
    /// Turns every other player gets after the call.
    pub others_final_turns: u8,
    /// End the round after this many turns (0 = no limit).
    pub turn_limit: u16,
}

impl Default for CaboRules {
    fn default() -> Self {
        use Power::*;
        CaboRules {
            starting_cards: 4,
            initial_peek_cards: 2,
            rank_values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
            red_king_value: 13,
            black_king_value: -1,
            rank_powers: [
                None, None, None, None, None, None, PeekOwn, PeekOwn, PeekOther, PeekOther,
                BlindSwap, BlindSwap, None,
            ],
            wrong_flush_penalty: 1,
            flush_own: true,
            flush_other: true,
            reshuffle_discard: true,
            end_round_when_player_out: false,
            cabo_enabled: true,
            caller_gets_final_turn: false,
            others_final_turns: 1,
            turn_limit: 0,
        }
    }
}

impl CaboRules {
    pub const MIN_PLAYERS: usize = 2;
    pub const MAX_PLAYERS: usize = 6;

    pub fn card_value(&self, c: Card) -> i32 {
        if c.rank() == 13 {
            (if c.is_red() { self.red_king_value } else { self.black_king_value }) as i32
        } else {
            self.rank_values[c.rank() as usize - 1] as i32
        }
    }

    pub fn power(&self, c: Card) -> Power {
        self.rank_powers[c.rank() as usize - 1]
    }

    pub fn validate(&self, players: usize) -> Result<(), String> {
        if !(Self::MIN_PLAYERS..=Self::MAX_PLAYERS).contains(&players) {
            return Err(format!("cabo requires {}-{} players", Self::MIN_PLAYERS, Self::MAX_PLAYERS));
        }
        if self.starting_cards == 0 || self.starting_cards > 8 {
            return Err("startingCards must be 1-8".into());
        }
        if self.initial_peek_cards > self.starting_cards {
            return Err("initialPeekCards cannot exceed startingCards".into());
        }
        if self.wrong_flush_penalty > 2 {
            return Err("wrongFlushPenalty must be 0-2".into());
        }
        if self.starting_cards as usize * players >= 52 {
            return Err("not enough cards to deal".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Phase {
    /// Everyone looks at their starting cards.
    InitialPeek,
    /// The current player must draw.
    TurnDraw,
    /// The current player holds a drawn card: keep it or discard it.
    DrawDecision,
    /// The current player must use the power of the discarded card.
    PowerPending,
    /// The current player ends the turn or calls Cabo.
    TurnEnd,
    /// Cards are revealed and scored.
    Complete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CaboAction {
    /// Look at the starting cards in the masked hand positions: all of them
    /// in one action on the live site, one card per action in simulation.
    PeekStarting { slots: u32 },
    Draw,
    /// Keep the drawn card in `slot`; the card that was there is discarded.
    Keep { slot: u8 },
    DiscardDrawn,
    PeekOwn { slot: u8 },
    PeekOther { target: Seat, slot: u8 },
    BlindSwap { own: u8, target: Seat, slot: u8 },
    /// Flush the masked own cards onto the discard pile; all must match its top.
    FlushOwn { slots: u32 },
    /// Flush another player's card.
    FlushOther { target: Seat, slot: u8 },
    /// Hand over a card owed after flushing another player's card.
    Transfer { slot: u8 },
    CallCabo,
    EndTurn,
    /// Simulation only: decline to flush.
    Pass,
}

/// A card owed by `from` to `to` after `from` flushed one of `to`'s cards.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Transfer {
    pub from: Seat,
    pub to: Seat,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaboCall {
    pub caller: Seat,
    /// Final turns started so far, per seat.
    pub taken: Vec<u8>,
}

/// What happened, at the level of detail everyone at the table can see. Card
/// identities appear only where the card was shown to all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CaboEvent {
    TurnStarted { seat: Seat },
    Peeked { seat: Seat, owner: Seat, slot: u8 },
    Drew { seat: Seat },
    Kept { seat: Seat, slot: u8, discarded: Card },
    Discarded { seat: Seat, card: Card },
    Swapped { seat: Seat, own: u8, target: Seat, slot: u8 },
    Flushed { seat: Seat, owner: Seat, slot: u8, card: Card },
    FailedFlushOwn { seat: Seat, slot: u8, card: Card },
    FailedFlushOther { seat: Seat, target: Seat, slot: u8 },
    Penalty { seat: Seat, slot: u8 },
    Transferred { from: Seat, from_slot: u8, to: Seat, to_slot: u8 },
    CaboCalled { seat: Seat, auto: bool },
    Reshuffled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoundResult {
    pub scores: Vec<i32>,
    pub winners: Vec<Seat>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cabo {
    pub rules: CaboRules,
    pub n: u8,
    pub phase: Phase,
    /// Hands keep their positions: a removed card leaves a gap.
    pub hands: Vec<Vec<Option<Card>>>,
    /// Cards whose identity each seat knows, wherever they now lie.
    pub known: Vec<CardSet>,
    pub deck: Vec<Card>,
    pub discard: Vec<Card>,
    pub turn: Seat,
    pub drawn: Option<Card>,
    /// Power the current player still has to use, with the card that gave it.
    pub pending_power: Option<(Power, Card)>,
    /// Cards owed after flushing other players' cards, oldest first. While
    /// any is owed, only flushes and the hand-over itself are allowed.
    pub transfers: Vec<Transfer>,
    pub cabo: Option<CaboCall>,
    /// Bit per seat that has not yet looked at its starting cards.
    pub peeks_remaining: u8,
    pub turns_started: u16,
    pub result: Option<RoundResult>,
    pub log: Vec<CaboEvent>,
    /// Simulation mode: flush opportunities are sequenced through `react`.
    pub sim: bool,
    /// Seats still to be asked whether they flush, next first.
    pub react: Vec<Seat>,
    rng: Rng,
    react_rng: Rng,
}

fn live(hand: &[Option<Card>]) -> usize {
    hand.iter().filter(|c| c.is_some()).count()
}

/// Put a card in the first gap, or at the end. Returns its position.
fn place(hand: &mut Vec<Option<Card>>, card: Card) -> usize {
    if let Some(gap) = hand.iter().position(|c| c.is_none()) {
        hand[gap] = Some(card);
        gap
    } else {
        hand.push(Some(card));
        hand.len() - 1
    }
}

fn bits(mask: u32) -> impl Iterator<Item = usize> {
    (0..MAX_SLOTS).filter(move |i| mask >> i & 1 == 1)
}

type Check = Result<(), Illegal>;

fn no(msg: &'static str) -> Check {
    Err(Illegal(msg))
}

impl Cabo {
    /// Deal a round. `sim` selects simulation mode (see the module docs).
    pub fn deal(rules: &CaboRules, players: usize, mut rng: Rng, sim: bool) -> Result<Cabo, String> {
        rules.validate(players)?;
        let mut deck = standard_deck(1);
        rng.shuffle(&mut deck);
        let first = rng.int(players) as Seat;
        let mut hands = vec![Vec::with_capacity(8); players];
        for _ in 0..rules.starting_cards {
            for hand in hands.iter_mut() {
                hand.push(deck.pop());
            }
        }
        let react_rng = if sim { rng.fork() } else { Rng::new(0) };
        let mut state = Cabo {
            rules: rules.clone(),
            n: players as u8,
            phase: Phase::InitialPeek,
            hands,
            known: vec![CardSet::EMPTY; players],
            deck,
            discard: Vec::new(),
            turn: first,
            drawn: None,
            pending_power: None,
            transfers: Vec::new(),
            cabo: None,
            peeks_remaining: ((1u16 << players) - 1) as u8,
            turns_started: 0,
            result: None,
            log: Vec::new(),
            sim,
            react: Vec::new(),
            rng,
            react_rng,
        };
        if rules.initial_peek_cards == 0 {
            state.peeks_remaining = 0;
            state.start_first_turn();
        }
        Ok(state)
    }

    pub fn live_count(&self, seat: Seat) -> usize {
        live(&self.hands[seat as usize])
    }

    fn card_at(&self, seat: Seat, slot: u8) -> Option<Card> {
        self.hands.get(seat as usize)?.get(slot as usize).copied().flatten()
    }

    fn flushing_allowed(&self) -> bool {
        self.rules.flush_own || self.rules.flush_other
    }

    /// The debtor who can pay first, if any card is owed.
    fn payer(&self) -> Option<Seat> {
        self.transfers.iter().map(|t| t.from).find(|&p| self.live_count(p) > 0)
    }

    // ---------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------

    /// Whether the rules of the game allow `seat` to do this now. In live mode
    /// this is the whole test; simulation mode adds `check_order`.
    pub fn check(&self, seat: Seat, action: &CaboAction) -> Check {
        use CaboAction::*;
        if seat >= self.n {
            return no("player not in this game");
        }
        if self.phase == Phase::Complete {
            return no("the round is over");
        }
        let owing = !self.transfers.is_empty();
        let my_turn = seat == self.turn;
        match *action {
            PeekStarting { slots } => {
                if self.phase != Phase::InitialPeek {
                    return no("not in initial peek phase");
                }
                if self.peeks_remaining >> seat & 1 == 0 {
                    return no("already peeked");
                }
                // Simulation mode looks at one card per action.
                let count = if self.sim { 1 } else { self.rules.initial_peek_cards as u32 };
                if slots.count_ones() != count {
                    return no("wrong number of cards to peek");
                }
                for i in bits(slots) {
                    match self.card_at(seat, i as u8) {
                        None => return no("peek index points at no card"),
                        Some(c) if self.known[seat as usize].has(c) => return no("already looked at that card"),
                        _ => {}
                    }
                }
                Ok(())
            }
            Draw => {
                if owing || self.phase != Phase::TurnDraw {
                    return no("not a draw moment");
                }
                if !my_turn {
                    return no("not your turn");
                }
                Ok(())
            }
            Keep { slot } => {
                if owing || self.phase != Phase::DrawDecision {
                    return no("no drawn card to resolve");
                }
                if !my_turn {
                    return no("not your turn");
                }
                if self.card_at(seat, slot).is_none() {
                    return no("hand index points at no card");
                }
                Ok(())
            }
            DiscardDrawn => {
                if owing || self.phase != Phase::DrawDecision {
                    return no("no drawn card to resolve");
                }
                if !my_turn {
                    return no("not your turn");
                }
                Ok(())
            }
            PeekOwn { .. } | PeekOther { .. } | BlindSwap { .. } => {
                let Some((power, _)) = self.pending_power else {
                    return no("no power pending");
                };
                if owing || self.phase != Phase::PowerPending {
                    return no("no power pending");
                }
                if !my_turn {
                    return no("you do not owe a power action");
                }
                match *action {
                    PeekOwn { slot } => {
                        if power != Power::PeekOwn {
                            return no("wrong power action");
                        }
                        if self.card_at(seat, slot).is_none() {
                            return no("card not in your hand");
                        }
                    }
                    PeekOther { target, slot } => {
                        if power != Power::PeekOther {
                            return no("wrong power action");
                        }
                        if target == seat || target >= self.n {
                            return no("must target another player");
                        }
                        if self.card_at(target, slot).is_none() {
                            return no("card not in target hand");
                        }
                    }
                    BlindSwap { own, target, slot } => {
                        if power != Power::BlindSwap {
                            return no("wrong power action");
                        }
                        if self.card_at(seat, own).is_none() {
                            return no("own card not in hand");
                        }
                        if target == seat || target >= self.n {
                            return no("must target another player");
                        }
                        if self.card_at(target, slot).is_none() {
                            return no("target card not in target hand");
                        }
                    }
                    _ => unreachable!(),
                }
                Ok(())
            }
            FlushOwn { slots } => {
                if self.phase == Phase::InitialPeek || !self.rules.flush_own {
                    return no("flushing not allowed now");
                }
                if self.discard.is_empty() {
                    return no("nothing to flush onto");
                }
                if slots == 0 {
                    return no("no cards selected");
                }
                for i in bits(slots) {
                    if self.card_at(seat, i as u8).is_none() {
                        return no("card not in your hand");
                    }
                }
                Ok(())
            }
            FlushOther { target, slot } => {
                if self.phase == Phase::InitialPeek || !self.rules.flush_other {
                    return no("flushing not allowed now");
                }
                if self.discard.is_empty() {
                    return no("nothing to flush onto");
                }
                if target == seat || target >= self.n {
                    return no("target must be another player");
                }
                if self.card_at(target, slot).is_none() {
                    return no("card not in target hand");
                }
                Ok(())
            }
            Transfer { slot } => {
                if !self.transfers.iter().any(|t| t.from == seat) {
                    return no("you have no pending transfer");
                }
                if self.card_at(seat, slot).is_none() {
                    return no("card not in your hand");
                }
                Ok(())
            }
            CallCabo => {
                if !self.rules.cabo_enabled {
                    return no("cabo calling disabled");
                }
                if owing || self.phase != Phase::TurnEnd {
                    return no("cabo is called at the end of your turn");
                }
                if !my_turn {
                    return no("not your turn");
                }
                if self.cabo.is_some() {
                    return no("cabo already called");
                }
                Ok(())
            }
            EndTurn => {
                if owing || self.phase != Phase::TurnEnd {
                    return no("nothing to end");
                }
                if !my_turn {
                    return no("not your turn");
                }
                Ok(())
            }
            Pass => {
                if !self.sim || self.react.first() != Some(&seat) || self.payer().is_some() {
                    return no("nothing to pass on");
                }
                Ok(())
            }
        }
    }

    /// Simulation mode: one seat decides at a time, in the order `to_act` gives.
    fn check_order(&self, seat: Seat, action: &CaboAction) -> Check {
        use CaboAction::*;
        if self.to_act() != Some(seat) {
            return no("not your move");
        }
        let flush = matches!(action, FlushOwn { .. } | FlushOther { .. });
        if self.payer().is_some() {
            return if matches!(action, Transfer { .. }) { Ok(()) } else { no("hand over the owed card first") };
        }
        if !self.react.is_empty() {
            return if flush || *action == Pass { Ok(()) } else { no("flush or pass") };
        }
        if flush {
            return no("no flush opportunity now");
        }
        Ok(())
    }

    // ---------------------------------------------------------------
    // Simulation interface
    // ---------------------------------------------------------------

    pub fn to_act(&self) -> Option<Seat> {
        if self.phase == Phase::Complete {
            return None;
        }
        if let Some(p) = self.payer() {
            return Some(p);
        }
        if let Some(&p) = self.react.first() {
            return Some(p);
        }
        if self.phase == Phase::InitialPeek {
            return Some(self.peeks_remaining.trailing_zeros() as Seat);
        }
        Some(self.turn)
    }

    pub fn legal_actions(&self, out: &mut Vec<CaboAction>) {
        use CaboAction::*;
        out.clear();
        let Some(seat) = self.to_act() else { return };
        let hand = &self.hands[seat as usize];
        let own = || (0..hand.len()).filter(|&i| hand[i].is_some()).map(|i| i as u8);
        let others = || {
            (0..self.n).filter(move |&t| t != seat).flat_map(move |t| {
                let h = &self.hands[t as usize];
                (0..h.len()).filter(move |&i| h[i].is_some()).map(move |i| (t, i as u8))
            })
        };
        if self.payer().is_some() {
            out.extend(own().map(|slot| Transfer { slot }));
            return;
        }
        if !self.react.is_empty() {
            out.push(Pass);
            if !self.discard.is_empty() {
                if self.rules.flush_own {
                    // Positions past the mask width cannot be named; hands never get there in real play.
                    out.extend(own().filter(|&slot| (slot as usize) < MAX_SLOTS).map(|slot| FlushOwn { slots: 1 << slot }));
                }
                if self.rules.flush_other {
                    out.extend(others().map(|(target, slot)| FlushOther { target, slot }));
                }
            }
            return;
        }
        match self.phase {
            Phase::InitialPeek => {
                let known = self.known[seat as usize];
                out.extend(
                    own().filter(|&i| !known.has(hand[i as usize].unwrap())).map(|i| PeekStarting { slots: 1 << i }),
                );
            }
            Phase::TurnDraw => out.push(Draw),
            Phase::DrawDecision => {
                out.push(DiscardDrawn);
                out.extend(own().map(|slot| Keep { slot }));
            }
            Phase::PowerPending => match self.pending_power.map(|p| p.0) {
                Some(Power::PeekOwn) => out.extend(own().map(|slot| PeekOwn { slot })),
                Some(Power::PeekOther) => out.extend(others().map(|(target, slot)| PeekOther { target, slot })),
                Some(Power::BlindSwap) => {
                    for o in own() {
                        out.extend(others().map(|(target, slot)| BlindSwap { own: o, target, slot }));
                    }
                }
                _ => {}
            },
            Phase::TurnEnd => {
                out.push(EndTurn);
                if self.rules.cabo_enabled && self.cabo.is_none() {
                    out.push(CallCabo);
                }
            }
            Phase::Complete => {}
        }
    }

    // ---------------------------------------------------------------
    // Mutation
    // ---------------------------------------------------------------

    pub fn apply(&mut self, seat: Seat, action: &CaboAction) -> Check {
        use CaboAction::*;
        self.check(seat, action)?;
        if self.sim {
            self.check_order(seat, action)?;
        }
        let s = seat as usize;
        match *action {
            PeekStarting { slots } => {
                for i in bits(slots) {
                    let c = self.hands[s][i].unwrap();
                    self.known[s].add(c);
                    self.log.push(CaboEvent::Peeked { seat, owner: seat, slot: i as u8 });
                }
                if !self.sim || self.known[s].len() >= self.rules.initial_peek_cards as usize {
                    self.peeks_remaining &= !(1 << seat);
                }
                if self.peeks_remaining == 0 {
                    self.start_first_turn();
                }
            }
            Draw => self.draw_card(),
            Keep { slot } => {
                let drawn = self.drawn.take().unwrap();
                let replaced = self.hands[s][slot as usize].replace(drawn).unwrap();
                self.to_discard(replaced);
                self.log.push(CaboEvent::Kept { seat, slot, discarded: replaced });
                self.after_discard(replaced);
                self.open_window();
            }
            DiscardDrawn => {
                let card = self.drawn.take().unwrap();
                self.to_discard(card);
                self.log.push(CaboEvent::Discarded { seat, card });
                self.after_discard(card);
                self.open_window();
            }
            PeekOwn { slot } => {
                let c = self.hands[s][slot as usize].unwrap();
                self.known[s].add(c);
                self.log.push(CaboEvent::Peeked { seat, owner: seat, slot });
                self.power_done();
                self.ask(seat);
            }
            PeekOther { target, slot } => {
                let c = self.hands[target as usize][slot as usize].unwrap();
                self.known[s].add(c);
                self.log.push(CaboEvent::Peeked { seat, owner: target, slot });
                self.power_done();
                self.ask(seat);
            }
            BlindSwap { own, target, slot } => {
                let mine = self.hands[s][own as usize];
                self.hands[s][own as usize] = self.hands[target as usize][slot as usize];
                self.hands[target as usize][slot as usize] = mine;
                self.log.push(CaboEvent::Swapped { seat, own, target, slot });
                self.power_done();
            }
            FlushOwn { slots } => {
                let top = *self.discard.last().unwrap();
                let picked: Vec<(usize, Card)> = bits(slots).map(|i| (i, self.hands[s][i].unwrap())).collect();
                let wrong: Vec<(usize, Card)> =
                    picked.iter().copied().filter(|(_, c)| c.rank() != top.rank()).collect();
                if !wrong.is_empty() {
                    // A wrong flush of your own card is shown to everyone.
                    for &(i, c) in &wrong {
                        for k in self.known.iter_mut() {
                            k.add(c);
                        }
                        self.log.push(CaboEvent::FailedFlushOwn { seat, slot: i as u8, card: c });
                    }
                    self.penalty(seat);
                    self.react.retain(|&p| p != seat);
                    return Ok(());
                }
                for (i, c) in picked {
                    self.hands[s][i] = None;
                    self.to_discard(c);
                    self.log.push(CaboEvent::Flushed { seat, owner: seat, slot: i as u8, card: c });
                }
                self.drop_unpayable_transfers();
                self.player_out_or_settle();
                self.open_window();
            }
            FlushOther { target, slot } => {
                let top = *self.discard.last().unwrap();
                let card = self.hands[target as usize][slot as usize].unwrap();
                if card.rank() != top.rank() {
                    // A wrong guess at someone else's card is shown to no one.
                    self.log.push(CaboEvent::FailedFlushOther { seat, target, slot });
                    self.penalty(seat);
                    self.react.retain(|&p| p != seat);
                    return Ok(());
                }
                self.hands[target as usize][slot as usize] = None;
                self.to_discard(card);
                self.log.push(CaboEvent::Flushed { seat, owner: target, slot, card });
                if self.live_count(seat) == 0 {
                    // Nothing to hand over.
                    self.drop_unpayable_transfers();
                    self.player_out_or_settle();
                } else {
                    self.transfers.push(self::Transfer { from: seat, to: target });
                    if self.rules.end_round_when_player_out && self.live_count(target) == 0 {
                        self.end_round();
                    }
                }
                self.open_window();
            }
            Transfer { slot } => {
                let ti = self.transfers.iter().position(|t| t.from == seat).unwrap();
                let t = self.transfers.remove(ti);
                let card = self.hands[s][slot as usize].take().unwrap();
                let to_slot = place(&mut self.hands[t.to as usize], card);
                self.log.push(CaboEvent::Transferred { from: seat, from_slot: slot, to: t.to, to_slot: to_slot as u8 });
                self.drop_unpayable_transfers();
                self.player_out_or_settle();
            }
            CallCabo => {
                self.call_cabo(seat, false);
                self.advance_turn();
            }
            EndTurn => {
                // Ending a turn with no cards calls Cabo automatically.
                if self.live_count(seat) == 0 && self.rules.cabo_enabled && self.cabo.is_none() {
                    self.call_cabo(seat, true);
                }
                self.advance_turn();
            }
            Pass => {
                self.react.remove(0);
            }
        }
        Ok(())
    }

    fn start_first_turn(&mut self) {
        self.phase = Phase::TurnDraw;
        self.turns_started = 1;
        self.log.push(CaboEvent::TurnStarted { seat: self.turn });
    }

    fn call_cabo(&mut self, seat: Seat, auto: bool) {
        self.cabo = Some(CaboCall { caller: seat, taken: vec![0; self.n as usize] });
        self.log.push(CaboEvent::CaboCalled { seat, auto });
    }

    /// Move a card to the discard pile; nobody needs to remember it any more.
    fn to_discard(&mut self, card: Card) {
        for k in self.known.iter_mut() {
            k.remove(card);
        }
        self.discard.push(card);
    }

    fn draw_card(&mut self) {
        if self.deck.is_empty() {
            if !self.rules.reshuffle_discard {
                self.end_round();
                return;
            }
            // Reshuffle the discard pile, keeping its top card in place.
            let top = self.discard.pop();
            self.deck = std::mem::take(&mut self.discard);
            self.rng.shuffle(&mut self.deck);
            self.discard.extend(top);
            self.log.push(CaboEvent::Reshuffled);
            if self.deck.is_empty() {
                self.end_round();
                return;
            }
        }
        let card = self.deck.pop().unwrap();
        self.drawn = Some(card);
        self.known[self.turn as usize].add(card);
        self.phase = Phase::DrawDecision;
        self.log.push(CaboEvent::Drew { seat: self.turn });
    }

    /// The discarded card's power must be used, unless it has no target.
    fn after_discard(&mut self, card: Card) {
        let power = self.rules.power(card);
        if power != Power::None && self.power_can_apply(self.turn, power) {
            self.pending_power = Some((power, card));
            self.phase = Phase::PowerPending;
        } else {
            self.end_action();
        }
    }

    fn power_done(&mut self) {
        self.pending_power = None;
        self.end_action();
    }

    fn power_can_apply(&self, seat: Seat, power: Power) -> bool {
        let own = self.live_count(seat) > 0;
        let other = (0..self.n).any(|p| p != seat && self.live_count(p) > 0);
        match power {
            Power::None => false,
            Power::PeekOwn => own,
            Power::PeekOther => other,
            Power::BlindSwap => own && other,
        }
    }

    fn penalty(&mut self, seat: Seat) {
        for _ in 0..self.rules.wrong_flush_penalty {
            let Some(card) = self.deck.pop() else { break };
            // Placed face-down: nobody learns it, not even its new owner.
            let slot = place(&mut self.hands[seat as usize], card);
            self.log.push(CaboEvent::Penalty { seat, slot: slot as u8 });
        }
    }

    /// The current player's action is complete: they may now end the turn or
    /// call Cabo. With no cards left, Cabo is called for them.
    fn end_action(&mut self) {
        let p = self.turn;
        if self.live_count(p) == 0 && self.rules.cabo_enabled && self.cabo.is_none() {
            self.call_cabo(p, true);
            self.advance_turn();
            return;
        }
        self.phase = Phase::TurnEnd;
        self.drawn = None;
    }

    fn player_out_or_settle(&mut self) {
        if self.rules.end_round_when_player_out && (0..self.n).any(|p| self.live_count(p) == 0) {
            self.end_round();
            return;
        }
        self.settle();
    }

    /// A flush or hand-over can empty the current player's hand before they
    /// draw, or remove every target of the power they owe. Resolve both the
    /// way the end of an action would.
    fn settle(&mut self) {
        if !self.transfers.is_empty() || self.phase == Phase::Complete {
            return;
        }
        let p = self.turn;
        if self.phase == Phase::PowerPending {
            if let Some((power, _)) = self.pending_power {
                if !self.power_can_apply(p, power) {
                    self.pending_power = None;
                    self.end_action();
                }
            }
            return;
        }
        if self.phase != Phase::TurnDraw || self.live_count(p) > 0 {
            return;
        }
        if self.rules.cabo_enabled && self.cabo.is_none() {
            self.call_cabo(p, true);
        }
        self.advance_turn();
    }

    /// A card owed by a player with no cards can never be paid.
    fn drop_unpayable_transfers(&mut self) {
        let hands = &self.hands;
        self.transfers.retain(|t| live(&hands[t.from as usize]) > 0);
    }

    fn advance_turn(&mut self) {
        let n = self.n;
        for step in 1..=n {
            let cand = (self.turn + step) % n;
            let cards = self.live_count(cand);
            // A player with no cards cannot draw: their turn is an automatic
            // Cabo call and they sit out.
            if self.cabo.is_none() && cards == 0 && self.rules.cabo_enabled {
                self.call_cabo(cand, true);
                continue;
            }
            let eligible = cards > 0
                && match &self.cabo {
                    None => true,
                    Some(c) => {
                        !(cand == c.caller && !self.rules.caller_gets_final_turn)
                            && c.taken[cand as usize] < self.rules.others_final_turns
                    }
                };
            if eligible {
                if self.rules.turn_limit > 0 && self.turns_started >= self.rules.turn_limit {
                    break;
                }
                self.turn = cand;
                self.phase = Phase::TurnDraw;
                self.drawn = None;
                if let Some(c) = &mut self.cabo {
                    c.taken[cand as usize] += 1;
                }
                self.turns_started += 1;
                self.log.push(CaboEvent::TurnStarted { seat: cand });
                return;
            }
        }
        self.end_round();
    }

    fn end_round(&mut self) {
        self.phase = Phase::Complete;
        self.drawn = None;
        self.pending_power = None;
        self.transfers.clear();
        self.react.clear();
        let mut table = CardSet::EMPTY;
        for hand in &self.hands {
            table.0 |= hand.iter().flatten().copied().collect::<CardSet>().0;
        }
        for k in self.known.iter_mut() {
            k.0 |= table.0;
        }
        let scores = self.scores();
        let best = *scores.iter().min().unwrap();
        let mut winners: Vec<Seat> = (0..self.n).filter(|&p| scores[p as usize] == best).collect();
        // On a tie the caller wins.
        if let Some(c) = &self.cabo {
            if winners.len() > 1 && winners.contains(&c.caller) {
                winners = vec![c.caller];
            }
        }
        self.result = Some(RoundResult { scores, winners });
    }

    /// Current total of every hand.
    pub fn scores(&self) -> Vec<i32> {
        self.hands.iter().map(|h| h.iter().flatten().map(|&c| self.rules.card_value(c)).sum()).collect()
    }

    // ---------------------------------------------------------------
    // Flush opportunities (simulation mode)
    // ---------------------------------------------------------------

    /// The top of the discard pile changed: ask every seat, in random order.
    fn open_window(&mut self) {
        if !self.sim || self.phase == Phase::Complete || !self.flushing_allowed() {
            return;
        }
        self.react.clear();
        self.react.extend(0..self.n);
        self.react_rng.shuffle(&mut self.react);
    }

    /// `seat` learned a card: it may now match the top of the discard pile.
    fn ask(&mut self, seat: Seat) {
        if !self.sim || self.phase == Phase::Complete || !self.flushing_allowed() || self.discard.is_empty() {
            return;
        }
        if !self.react.contains(&seat) {
            self.react.push(seat);
        }
    }

    // ---------------------------------------------------------------
    // A table round put to the model
    // ---------------------------------------------------------------

    /// See `Game::for_seat`. While a card is owed nobody is asked to flush,
    /// as in simulation. Before play starts, the seats that simulation would
    /// have asked before `seat` look at cards chosen at random.
    pub fn for_seat(&self, seat: Seat, reacting: bool, rng: &mut Rng) -> Option<Cabo> {
        if self.phase == Phase::Complete || seat >= self.n {
            return None;
        }
        if self.sim {
            return (!reacting && self.to_act() == Some(seat)).then(|| self.clone());
        }
        let mut g = self.clone();
        g.sim = true;
        g.react_rng = rng.fork();
        if let Some(p) = g.payer() {
            return (p == seat).then_some(g);
        }
        if reacting {
            if !g.flushing_allowed() || g.discard.is_empty() || g.phase == Phase::InitialPeek {
                return None;
            }
            g.react.push(seat);
            return Some(g);
        }
        if g.phase == Phase::InitialPeek {
            if g.peeks_remaining >> seat & 1 == 0 {
                return None;
            }
            let mut legal = Vec::new();
            while let Some(p) = g.to_act().filter(|&p| p < seat) {
                g.legal_actions(&mut legal);
                let action = legal[rng.int(legal.len())];
                g.apply(p, &action).ok()?;
            }
        }
        (g.to_act() == Some(seat)).then_some(g)
    }

    /// See `Game::at_table`: a pass is nothing at the table, and the starting
    /// cards are looked at in one action there.
    pub fn at_table(&self, seat: Seat, action: &CaboAction) -> AtTable<CaboAction> {
        match *action {
            CaboAction::Pass => AtTable::Nothing,
            CaboAction::PeekStarting { slots } => {
                let known = self.known[seat as usize];
                let seen = self.hands[seat as usize]
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| c.is_some_and(|c| known.has(c)))
                    .fold(slots, |mask, (i, _)| mask | 1 << i);
                if seen.count_ones() >= self.rules.initial_peek_cards as u32 {
                    AtTable::Play(CaboAction::PeekStarting { slots: seen })
                } else {
                    AtTable::More
                }
            }
            action => AtTable::Play(action),
        }
    }

    // ---------------------------------------------------------------
    // Comparison with the original TypeScript engine
    // ---------------------------------------------------------------

    /// The state in the shape `scripts/parity` builds from the TypeScript
    /// engine, cards as `suit * 13 + rank - 1`.
    pub fn ts_snapshot(&self) -> Value {
        let phase = if self.phase != Phase::Complete && !self.transfers.is_empty() {
            "TRANSFER_PENDING"
        } else {
            ts_phase(self.phase)
        };
        json!({
            "phase": phase,
            "turn": self.turn,
            "hands": self.hands,
            "deck": self.deck,
            "discard": self.discard,
            "drawn": self.drawn,
            "pendingPower": self.pending_power.map(|(p, c)| json!({ "power": p, "source": c })),
            "transfers": self.transfers.iter().map(|t| json!({
                "from": t.from, "to": t.to, "phaseBefore": ts_phase(self.phase),
            })).collect::<Vec<_>>(),
            "cabo": self.cabo.as_ref().map(|c| json!({ "caller": c.caller, "taken": c.taken })),
            "peeksRemaining": (0..self.n).filter(|p| self.peeks_remaining >> p & 1 == 1).collect::<Vec<_>>(),
            "knowledge": self.known.iter().map(|k| k.iter().collect::<Vec<_>>()).collect::<Vec<_>>(),
            "scores": self.result.as_ref().map(|r| r.scores.clone()),
            "winners": self.result.as_ref().map(|r| r.winners.clone()),
        })
    }
}

fn ts_phase(p: Phase) -> &'static str {
    match p {
        Phase::InitialPeek => "INITIAL_PEEK",
        Phase::TurnDraw => "TURN_DRAW",
        Phase::DrawDecision => "DRAW_DECISION",
        Phase::PowerPending => "POWER_PENDING",
        Phase::TurnEnd => "TURN_END",
        Phase::Complete => "ROUND_COMPLETE",
    }
}

impl CaboRules {
    /// These rules as the TypeScript engine's `CaboRules` object.
    pub fn to_ts(&self) -> Value {
        let rank_values: serde_json::Map<String, Value> =
            (0..13).map(|i| ((i + 1).to_string(), json!(self.rank_values[i]))).collect();
        let bands: Vec<Value> = (0..13)
            .filter(|&i| self.rank_powers[i] != Power::None)
            .map(|i| json!({ "from": i + 1, "to": i + 1, "power": self.rank_powers[i] }))
            .collect();
        let penalty = ["none", "draw_one", "draw_two"][self.wrong_flush_penalty as usize];
        json!({
            "startingCards": self.starting_cards,
            "initialPeekCards": self.initial_peek_cards,
            "rankValues": rank_values,
            "kingValues": { "red": self.red_king_value, "black": self.black_king_value },
            "powerBands": bands,
            "wrongFlushPenalty": penalty,
            "emptyDeckBehavior": if self.reshuffle_discard { "reshuffle_discard" } else { "end_round" },
            "endRoundWhenPlayerHasNoCards": self.end_round_when_player_out,
            "cabo": {
                "enabled": self.cabo_enabled,
                "callerGetsFinalTurn": self.caller_gets_final_turn,
                "othersFinalTurns": self.others_final_turns,
            },
            "minPlayers": Self::MIN_PLAYERS,
            "maxPlayers": Self::MAX_PLAYERS,
        })
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_games_hold_the_invariants() {
        // Random play need not end without a turn limit.
        let limit = |rules: &mut Value, rng: &mut Rng| rules["turnLimit"] = json!(1 + rng.int(120));
        let report = crate::check::fuzz::<Cabo>(300, 11, 2..=6, 20_000, limit).unwrap_or_else(|e| panic!("{e}"));
        println!("{report:?}");
        assert!(report.games == 300, "{report:?}");
    }

    /// A table round played only through `for_seat` and `at_table`: every
    /// move chosen in the simulation form is accepted at the table.
    #[test]
    fn table_rounds_can_be_played_through_the_simulation_form() {
        let mut rng = Rng::new(21);
        let (mut finished, mut flushes, mut passes) = (0, 0, 0);
        for game in 0..60 {
            let players = 2 + rng.int(5);
            let rules = CaboRules { turn_limit: 40, ..CaboRules::default() };
            let mut table = Cabo::deal(&rules, players, Rng::new(game), false).unwrap();
            let mut legal = Vec::new();
            for _ in 0..4_000 {
                if table.phase == Phase::Complete {
                    break;
                }
                let seat = rng.int(players) as Seat;
                let reacting = rng.int(3) == 0;
                let Some(mut asked) = table.for_seat(seat, reacting, &mut rng) else { continue };
                let mut obs = crate::Obs::default();
                loop {
                    assert_eq!(asked.to_act(), Some(seat));
                    asked.observe(seat, false, &mut obs);
                    asked.legal_actions(&mut legal);
                    assert_eq!(obs.actions.len(), legal.len());
                    // Mostly decline to flush, or random play is all penalty cards.
                    let pass = legal[0] == CaboAction::Pass && rng.int(4) > 0;
                    let action = if pass { legal[0] } else { legal[rng.int(legal.len())] };
                    match asked.at_table(seat, &action) {
                        AtTable::Play(a) => {
                            table.apply(seat, &a).unwrap_or_else(|e| panic!("{a:?} refused at the table: {e}"));
                            flushes += matches!(a, CaboAction::FlushOwn { .. } | CaboAction::FlushOther { .. }) as u32;
                            break;
                        }
                        AtTable::Nothing => {
                            passes += 1;
                            break;
                        }
                        AtTable::More => asked.apply(seat, &action).unwrap(),
                    }
                }
            }
            finished += (table.phase == Phase::Complete) as u32;
        }
        assert!(finished >= 55 && flushes > 20 && passes > 20, "{finished} finished, {flushes} flushes, {passes} passes");
    }
}
