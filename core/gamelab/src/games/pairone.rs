//! Pair One: a memory game played in the open.
//!
//! The deck is shuffled into a grid of face-down cards. On your turn you turn
//! up two cards, one after the other, and everyone sees them. Two of the same
//! rank are yours and you go again; otherwise both turn back and the turn
//! passes. The round ends when the grid is empty; most pairs wins.
//!
//! Nothing is private: the only hidden things are the cards nobody has turned
//! up yet, and every player knows the same amount.

use crate::cards::{Card, CardSet, SUITS};
use crate::game::{winner_returns, Game, Illegal, Seat, Stat};
use crate::obs::{field, game_code, kind, rel, zone, ActionToken, Obs, Token, NO_ARG};
use crate::rng::Rng;
use crate::settings::{Choice, Setting, SettingKind};
use serde::{Deserialize, Serialize};
use serde_json::json;

const G: u16 = 3;
const EVENT_BASE: u16 = 1;
const RULE_BASE: u16 = 20;
/// Events shown in an observation.
const HISTORY: usize = 12;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PairOneRules {
    /// Ranks in the grid, counted up from the ace.
    pub ranks: u8,
    /// Cards of each rank: 2 or 4.
    pub copies: u8,
    /// A player who finds a pair plays again.
    pub extra_turn: bool,
}

impl Default for PairOneRules {
    fn default() -> Self {
        PairOneRules { ranks: 13, copies: 4, extra_turn: true }
    }
}

impl PairOneRules {
    fn validate(&self, players: usize) -> Result<(), String> {
        if !(2..=6).contains(&players) {
            return Err("pair one requires 2-6 players".into());
        }
        if !(2..=13).contains(&self.ranks) || ![2, 4].contains(&self.copies) {
            return Err("a setting is out of range".into());
        }
        Ok(())
    }

    fn deck(&self) -> Vec<Card> {
        let mut deck = Vec::new();
        for suit in SUITS.iter().take(self.copies as usize) {
            for rank in 1..=self.ranks {
                deck.push(Card::new(*suit, rank));
            }
        }
        deck
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PairOneAction {
    /// Turn up the card at a grid position.
    Flip { slot: u8 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PairOneEvent {
    Flipped { seat: Seat, slot: u8, card: Card },
    Collected { seat: Seat },
    Missed { seat: Seat },
}

/// The last pair of cards that did not match.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Miss {
    pub seat: Seat,
    pub slots: [u8; 2],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PairOne {
    pub rules: PairOneRules,
    pub n: u8,
    /// The grid, row by row. A collected card leaves a gap, so every other
    /// card keeps its place.
    pub grid: Vec<Option<Card>>,
    pub turn: Seat,
    /// Position of the first card turned up this turn.
    pub flipped: Option<u8>,
    /// Cards each player has collected, in order.
    pub collections: Vec<Vec<Card>>,
    /// Every card that has been turned up at some point.
    pub seen: CardSet,
    pub last_miss: Option<Miss>,
    pub over: bool,
    pub log: Vec<PairOneEvent>,
}

impl PairOne {
    pub fn pairs(&self, seat: Seat) -> usize {
        self.collections[seat as usize].len() / 2
    }

    pub fn remaining(&self) -> usize {
        self.grid.iter().flatten().count()
    }

    /// The players with the most pairs. Only meaningful once the round is over.
    pub fn winners(&self) -> Vec<Seat> {
        let best = (0..self.n).map(|p| self.pairs(p)).max().unwrap();
        (0..self.n).filter(|&p| self.pairs(p) == best).collect()
    }

    fn check(&self, seat: Seat, slot: u8) -> Result<Card, Illegal> {
        if seat >= self.n {
            return Err(Illegal("player not in this game"));
        }
        if self.over {
            return Err(Illegal("the round is over"));
        }
        if seat != self.turn {
            return Err(Illegal("not your turn"));
        }
        let Some(card) = self.grid.get(slot as usize).copied().flatten() else {
            return Err(Illegal("card is not on the table"));
        };
        if self.flipped == Some(slot) {
            return Err(Illegal("that card is already flipped"));
        }
        Ok(card)
    }

    /// The state in the shape the TypeScript engine is compared in.
    pub fn ts_snapshot(&self) -> serde_json::Value {
        let face = |c: &Card| c.face();
        let at = |slot: u8| self.grid[slot as usize].map(|c| c.face());
        let mut seen: Vec<u8> = self.seen.iter().map(|c| c.face()).collect();
        seen.sort();
        json!({
            "phase": if self.over { "ROUND_COMPLETE" } else { "TURN" },
            "turn": self.turn,
            "grid": self.grid.iter().map(|c| c.as_ref().map(face)).collect::<Vec<_>>(),
            "flipped": self.flipped.map(at).into_iter().collect::<Vec<_>>(),
            "collections": self.collections.iter().map(|c| c.iter().map(face).collect::<Vec<_>>()).collect::<Vec<_>>(),
            "knowledge": seen,
            "lastMiss": self.last_miss.map(|m| json!({ "seat": m.seat, "cards": m.slots.map(at) })),
            "scores": self.over.then(|| (0..self.n).map(|p| self.pairs(p)).collect::<Vec<_>>()),
            "winners": self.over.then(|| self.winners()),
        })
    }
}

impl Game for PairOne {
    const ID: &'static str = "pairone";
    const NUMBER: u16 = G;
    const PLAYERS: (usize, usize) = (2, 6);
    type Rules = PairOneRules;
    type Action = PairOneAction;

    fn new(rules: &PairOneRules, players: usize, mut rng: Rng) -> Result<Self, String> {
        rules.validate(players)?;
        let mut deck = rules.deck();
        rng.shuffle(&mut deck);
        Ok(PairOne {
            rules: rules.clone(),
            n: players as u8,
            grid: deck.into_iter().map(Some).collect(),
            turn: 0,
            flipped: None,
            collections: vec![Vec::new(); players],
            seen: CardSet::EMPTY,
            last_miss: None,
            over: false,
            log: Vec::new(),
        })
    }

    fn players(&self) -> usize {
        self.n as usize
    }

    fn is_over(&self) -> bool {
        self.over
    }

    fn to_act(&self) -> Option<Seat> {
        (!self.over).then_some(self.turn)
    }

    fn legal_actions(&self, out: &mut Vec<PairOneAction>) {
        out.clear();
        if self.over {
            return;
        }
        for (i, c) in self.grid.iter().enumerate() {
            if c.is_some() && self.flipped != Some(i as u8) {
                out.push(PairOneAction::Flip { slot: i as u8 });
            }
        }
    }

    fn apply(&mut self, seat: Seat, action: &PairOneAction) -> Result<(), Illegal> {
        let PairOneAction::Flip { slot } = *action;
        let card = self.check(seat, slot)?;
        self.last_miss = None;
        self.seen.add(card);
        self.log.push(PairOneEvent::Flipped { seat, slot, card });

        let Some(first) = self.flipped.take() else {
            self.flipped = Some(slot);
            return Ok(());
        };
        let other = self.grid[first as usize].unwrap();
        if other.rank() == card.rank() {
            self.grid[first as usize] = None;
            self.grid[slot as usize] = None;
            self.collections[seat as usize].extend([other, card]);
            self.log.push(PairOneEvent::Collected { seat });
            if self.remaining() == 0 {
                self.over = true;
            } else if !self.rules.extra_turn {
                self.turn = (self.turn + 1) % self.n;
            }
        } else {
            self.last_miss = Some(Miss { seat, slots: [first, slot] });
            self.log.push(PairOneEvent::Missed { seat });
            self.turn = (self.turn + 1) % self.n;
        }
        Ok(())
    }

    fn returns(&self) -> Vec<f32> {
        winner_returns(self.n as usize, &self.winners())
    }

    fn settings() -> Vec<Setting> {
        vec![
            Setting::int("Grid", "ranks", "Ranks", "Ranks in the grid, counted up from the ace.", 2, 13),
            Setting {
                key: "copies",
                label: "Cards of each rank",
                help: "With two, every card has exactly one partner.",
                group: "Grid",
                kind: SettingKind::Choice {
                    options: vec![Choice { value: json!(2), label: "Two" }, Choice { value: json!(4), label: "Four" }],
                },
            },
            Setting::bool("Turns", "extraTurn", "Play again after a pair", "A player who finds a pair takes another turn."),
        ]
    }

    fn verbs() -> Vec<(u16, &'static str)> {
        vec![(1, "Flip")]
    }

    fn stat_names() -> Vec<Stat> {
        vec![
            Stat::new("turns", "Turns"),
            Stat::new("winnerPairs", "Pairs of the winner"),
            Stat::new("margin", "Lead of the winner over the runner-up, in pairs"),
            Stat::new("longestRun", "Longest run of pairs in one turn"),
        ]
    }

    fn stats(&self) -> Vec<f32> {
        let mut pairs: Vec<usize> = (0..self.n).map(|p| self.pairs(p)).collect();
        pairs.sort_unstable_by(|a, b| b.cmp(a));
        let again = self.rules.extra_turn;
        let (mut turns, mut run, mut longest) = (0, 0, 0);
        for e in &self.log {
            match e {
                PairOneEvent::Collected { .. } => {
                    run = if again { run + 1 } else { 1 };
                    longest = longest.max(run);
                    turns += !again as usize;
                }
                PairOneEvent::Missed { .. } => {
                    run = 0;
                    turns += 1;
                }
                PairOneEvent::Flipped { .. } => {}
            }
        }
        // With extra turns the round ends inside the turn that took the last pair.
        turns += again as usize;
        vec![turns as f32, pairs[0] as f32, (pairs[0] - pairs[1]) as f32, longest as f32]
    }

    fn observe(&self, me: Seat, omniscient: bool, obs: &mut Obs) {
        obs.clear();
        let n = self.n;
        let r = |s: Seat| rel(me, s, n);
        let everyone = (1u16 << n) - 1;

        let mut global = Token::new(kind::GLOBAL, game_code(G, 0)).aux(self.remaining());
        // Which decision this is: 1 first card, 2 second card, 3 round over.
        global.0[field::SLOT] = if self.over { 3 } else { 1 + self.flipped.is_some() as u16 };
        global.0[field::RANK] = n as u16;
        if !self.over {
            global = global.seat(r(self.turn));
        }
        obs.push(global);

        for p in 0..n {
            let t = Token::new(kind::PLAYER, 0)
                .seat(r(p))
                .flags((!self.over && p == self.turn) as u16)
                .value(self.pairs(p) as i32);
            obs.push(t);
        }

        let mut at = vec![NO_ARG; self.grid.len()];
        for (i, c) in self.grid.iter().enumerate() {
            let Some(card) = *c else { continue };
            let seen = self.seen.has(card);
            let mut t = Token::new(kind::CARD, zone::TABLE)
                .slot(i)
                .flags(if seen { everyone } else { 0 })
                .aux((self.flipped == Some(i as u8)) as usize);
            if seen || omniscient {
                t = t.face(card);
            }
            at[i] = obs.push(t) as u16;
        }

        for (age, e) in self.log.iter().rev().take(HISTORY).enumerate() {
            use PairOneEvent::*;
            let ev = |i: u16, seat: Seat| Token::new(kind::EVENT, game_code(G, EVENT_BASE + i)).seat(r(seat)).aux(age);
            obs.push(match *e {
                Flipped { seat, slot, card } => ev(0, seat).slot(slot as usize).face(card),
                Collected { seat } => ev(1, seat),
                Missed { seat } => ev(2, seat),
            });
        }

        let rules = [self.rules.ranks as i32, self.rules.copies as i32, self.rules.extra_turn as i32];
        for (i, v) in rules.into_iter().enumerate() {
            obs.push(Token::new(kind::RULE, game_code(G, RULE_BASE + i as u16)).value(v));
        }

        if self.to_act() == Some(me) {
            for (i, c) in self.grid.iter().enumerate() {
                if c.is_some() && self.flipped != Some(i as u8) {
                    obs.actions.push(ActionToken::new(game_code(G, 1)).arg(0, at[i] as usize));
                }
            }
        }
    }

    fn determinize(&self, _seat: Seat, rng: &mut Rng) -> Self {
        let mut g = self.clone();
        let seen = self.seen;
        let mut pool: Vec<Card> = g.grid.iter().flatten().copied().filter(|c| !seen.has(*c)).collect();
        rng.shuffle(&mut pool);
        for c in g.grid.iter_mut().flatten().filter(|c| !seen.has(**c)) {
            *c = pool.pop().unwrap();
        }
        g
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_games_hold_the_invariants() {
        let report = crate::check::fuzz::<PairOne>(300, 3, 2..=6, 50_000, |_, _| {}).unwrap();
        println!("{report:?}");
    }
}
