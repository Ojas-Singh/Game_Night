//! Mini poker: a small fixed-limit poker family.
//!
//! Each player antes and gets one face-down card. There is one betting round,
//! or two with a face-up table card dealt between them. Bets have a fixed size
//! per round and a cap on how many may be made in a round. At showdown a card
//! that pairs the table card wins, otherwise the highest rank; ties split.
//!
//! The settings cover the two standard research games: `MiniPokerRules::kuhn()`
//! is Kuhn poker and the default is Leduc hold'em. Both are small enough to
//! solve exactly (`crate::exact`), which makes them the reference for checking
//! that a learned player is close to unbeatable and not merely strong against
//! the opponents it met.
//!
//! All cards are dealt at the start, so the game is deterministic after the
//! deal; the table card just stays hidden until the second round.

use crate::cards::{Card, SUITS};
use crate::exact::Enumerable;
use crate::game::{Game, Illegal, Seat, Stat};
use crate::obs::{field, game_code, kind, rel, zone, ActionToken, Obs, Token};
use crate::rng::Rng;
use crate::settings::Setting;
use serde::{Deserialize, Serialize};

const G: u16 = 2;
const EVENT_BASE: u16 = 1;
const RULE_BASE: u16 = 20;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MiniPokerRules {
    /// Ranks in the deck, counted down from the king.
    pub ranks: u8,
    /// Copies of each rank.
    pub suits: u8,
    /// Betting rounds; the second is played with a table card.
    pub rounds: u8,
    pub ante: u8,
    /// Size of a bet or raise in the first and in the second round.
    pub first_bet: u8,
    pub second_bet: u8,
    /// Bets and raises allowed in one round.
    pub max_bets: u8,
}

impl Default for MiniPokerRules {
    /// Leduc hold'em.
    fn default() -> Self {
        MiniPokerRules { ranks: 3, suits: 2, rounds: 2, ante: 1, first_bet: 2, second_bet: 4, max_bets: 2 }
    }
}

impl MiniPokerRules {
    pub fn kuhn() -> Self {
        MiniPokerRules { ranks: 3, suits: 1, rounds: 1, ante: 1, first_bet: 1, second_bet: 1, max_bets: 1 }
    }

    fn deck(&self) -> Vec<Card> {
        let mut deck = Vec::new();
        for rank in (14 - self.ranks)..=13 {
            for suit in SUITS.iter().take(self.suits as usize) {
                deck.push(Card::new(*suit, rank));
            }
        }
        deck
    }

    fn validate(&self, players: usize) -> Result<(), String> {
        if !(2..=4).contains(&players) {
            return Err("mini poker is for 2 to 4 players".into());
        }
        let ok = (2..=13).contains(&self.ranks)
            && (1..=4).contains(&self.suits)
            && (1..=2).contains(&self.rounds)
            && (1..=5).contains(&self.ante)
            && (1..=8).contains(&self.first_bet)
            && (1..=8).contains(&self.second_bet)
            && (1..=4).contains(&self.max_bets);
        if !ok {
            return Err("a setting is out of range".into());
        }
        if ((self.ranks * self.suits) as usize) < players + (self.rounds == 2) as usize {
            return Err("not enough cards in the deck".into());
        }
        Ok(())
    }

    fn scalar_tokens(&self) -> [i32; 7] {
        [self.ranks, self.suits, self.rounds, self.ante, self.first_bet, self.second_bet, self.max_bets].map(i32::from)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MiniPokerAction {
    Fold,
    Check,
    Call,
    Bet,
    Raise,
}

/// One action in the betting history.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Move {
    pub seat: Seat,
    pub action: MiniPokerAction,
    pub round: u8,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MiniPoker {
    pub rules: MiniPokerRules,
    pub n: u8,
    /// Each player's card.
    pub hole: Vec<Card>,
    /// The table card; face-down until the second round.
    pub table: Option<Card>,
    /// Cards not dealt.
    pub deck: Vec<Card>,
    pub round: u8,
    /// Bit per seat that has folded.
    pub folded: u8,
    /// Chips each seat has put in, in total and in this round.
    pub paid: Vec<u16>,
    pub paid_round: Vec<u16>,
    /// Bets and raises made in this round.
    pub bets: u8,
    /// Players who must still act before the round closes.
    pub pending: u8,
    pub turn: Seat,
    pub over: bool,
    pub history: Vec<Move>,
}

impl MiniPoker {
    fn from_deal(rules: &MiniPokerRules, players: usize, mut cards: Vec<Card>) -> MiniPoker {
        let hole = cards.drain(..players).collect();
        let table = (rules.rounds == 2).then(|| cards.remove(0));
        MiniPoker {
            rules: rules.clone(),
            n: players as u8,
            hole,
            table,
            deck: cards,
            round: 0,
            folded: 0,
            paid: vec![rules.ante as u16; players],
            paid_round: vec![0; players],
            bets: 0,
            pending: players as u8,
            turn: 0,
            over: false,
            history: Vec::new(),
        }
    }

    fn active(&self, seat: Seat) -> bool {
        self.folded >> seat & 1 == 0
    }

    fn active_count(&self) -> u8 {
        self.n - self.folded.count_ones() as u8
    }

    fn to_call(&self, seat: Seat) -> u16 {
        self.paid_round.iter().max().unwrap() - self.paid_round[seat as usize]
    }

    fn bet_size(&self) -> u16 {
        (if self.round == 0 { self.rules.first_bet } else { self.rules.second_bet }) as u16
    }

    pub fn pot(&self) -> u16 {
        self.paid.iter().sum()
    }

    /// Whether the table card is face-up.
    pub fn table_shown(&self) -> bool {
        self.round == 1
    }

    fn next_active(&self, after: Seat) -> Seat {
        (1..=self.n).map(|k| (after + k) % self.n).find(|&p| self.active(p)).unwrap()
    }

    fn pay(&mut self, seat: Seat, chips: u16) {
        self.paid[seat as usize] += chips;
        self.paid_round[seat as usize] += chips;
    }

    /// Showdown strength: a pair with the table card beats any unpaired card.
    fn strength(&self, seat: Seat) -> u16 {
        let rank = self.hole[seat as usize].rank() as u16;
        let pair = self.table.is_some_and(|t| t.rank() as u16 == rank);
        rank + if pair { 100 } else { 0 }
    }

    pub fn winners(&self) -> Vec<Seat> {
        let live: Vec<Seat> = (0..self.n).filter(|&p| self.active(p)).collect();
        let best = live.iter().map(|&p| self.strength(p)).max().unwrap();
        live.into_iter().filter(|&p| self.strength(p) == best).collect()
    }
}

impl Game for MiniPoker {
    const ID: &'static str = "minipoker";
    const NUMBER: u16 = G;
    const PLAYERS: (usize, usize) = (2, 4);
    type Rules = MiniPokerRules;
    type Action = MiniPokerAction;

    fn new(rules: &MiniPokerRules, players: usize, mut rng: Rng) -> Result<Self, String> {
        rules.validate(players)?;
        let mut deck = rules.deck();
        rng.shuffle(&mut deck);
        Ok(MiniPoker::from_deal(rules, players, deck))
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

    fn legal_actions(&self, out: &mut Vec<MiniPokerAction>) {
        use MiniPokerAction::*;
        out.clear();
        if self.over {
            return;
        }
        let may_bet = self.bets < self.rules.max_bets;
        if self.to_call(self.turn) == 0 {
            out.push(Check);
            if may_bet {
                out.push(Bet);
            }
        } else {
            out.extend([Fold, Call]);
            if may_bet {
                out.push(Raise);
            }
        }
    }

    fn apply(&mut self, seat: Seat, action: &MiniPokerAction) -> Result<(), Illegal> {
        use MiniPokerAction::*;
        if self.over {
            return Err(Illegal("the hand is over"));
        }
        if seat != self.turn {
            return Err(Illegal("not your turn"));
        }
        let owed = self.to_call(seat);
        let may_bet = self.bets < self.rules.max_bets;
        match action {
            Fold if owed > 0 => self.folded |= 1 << seat,
            Check if owed == 0 => {}
            Call if owed > 0 => self.pay(seat, owed),
            Bet if owed == 0 && may_bet => self.pay(seat, self.bet_size()),
            Raise if owed > 0 && may_bet => self.pay(seat, owed + self.bet_size()),
            _ => return Err(Illegal("that action is not available")),
        }
        self.history.push(Move { seat, action: *action, round: self.round });
        if matches!(action, Bet | Raise) {
            self.bets += 1;
            self.pending = self.active_count() - 1;
        } else {
            self.pending -= 1;
        }

        if self.active_count() == 1 {
            self.over = true;
        } else if self.pending > 0 {
            self.turn = self.next_active(seat);
        } else if self.round + 1 < self.rules.rounds {
            self.round += 1;
            self.bets = 0;
            self.paid_round.iter_mut().for_each(|p| *p = 0);
            self.pending = self.active_count();
            self.turn = self.next_active(self.n - 1);
        } else {
            self.over = true;
        }
        Ok(())
    }

    /// Chips won or lost.
    fn returns(&self) -> Vec<f32> {
        let winners = self.winners();
        let share = self.pot() as f32 / winners.len() as f32;
        (0..self.n).map(|p| if winners.contains(&p) { share } else { 0.0 } - self.paid[p as usize] as f32).collect()
    }

    fn verbs() -> Vec<(u16, &'static str)> {
        vec![(1, "Fold"), (2, "Check"), (3, "Call"), (4, "Bet"), (5, "Raise")]
    }

    fn stat_names() -> Vec<Stat> {
        vec![
            Stat::new("pot", "Pot"),
            Stat::new("showdown", "Went to a showdown"),
            Stat::new("secondRound", "Reached the second betting round"),
            Stat::new("raises", "Bets and raises"),
            Stat::new("bestCardWon", "The best hand won"),
        ]
    }

    fn stats(&self) -> Vec<f32> {
        let raises = self.history.iter().filter(|m| matches!(m.action, MiniPokerAction::Bet | MiniPokerAction::Raise));
        let best = (0..self.n).map(|p| self.strength(p)).max().unwrap();
        let best_won = self.winners().iter().any(|&p| self.strength(p) == best);
        vec![
            self.pot() as f32,
            (self.active_count() > 1) as u8 as f32,
            (self.round > 0) as u8 as f32,
            raises.count() as f32,
            best_won as u8 as f32,
        ]
    }

    fn settings() -> Vec<Setting> {
        let (deck, betting) = ("Deck", "Betting");
        vec![
            Setting::int(deck, "ranks", "Ranks", "Ranks in the deck, counted down from the king.", 2, 13),
            Setting::int(deck, "suits", "Copies of each rank", "How many cards of each rank are in the deck.", 1, 4),
            Setting::int(
                betting,
                "rounds",
                "Betting rounds",
                "With two rounds, a table card is turned up before the second; pairing it wins.",
                1,
                2,
            ),
            Setting::int(betting, "ante", "Ante", "Chips every player puts in before the deal.", 1, 5),
            Setting::int(betting, "firstBet", "First-round bet", "Size of a bet or raise in the first round.", 1, 8),
            Setting::int(betting, "secondBet", "Second-round bet", "Size of a bet or raise in the second round.", 1, 8),
            Setting::int(betting, "maxBets", "Bets per round", "How many bets and raises one round allows.", 1, 4),
        ]
    }

    fn presets() -> Vec<(&'static str, MiniPokerRules)> {
        vec![("Leduc hold'em", MiniPokerRules::default()), ("Kuhn poker", MiniPokerRules::kuhn())]
    }

    fn observe(&self, me: Seat, omniscient: bool, obs: &mut Obs) {
        obs.clear();
        let n = self.n;
        let r = |s: Seat| rel(me, s, n);

        let mut global = Token::new(kind::GLOBAL, game_code(G, 0))
            .flags(self.over as u16)
            .value(self.pot() as i32)
            .aux(self.bets as usize);
        global.0[field::SLOT] = self.round as u16 + 1;
        global.0[field::RANK] = n as u16;
        if !self.over {
            global = global.seat(r(self.turn));
        }
        obs.push(global);

        for p in 0..n {
            let flags = (!self.over && p == self.turn) as u16 | (!self.active(p) as u16) << 1;
            let t = Token::new(kind::PLAYER, 0)
                .seat(r(p))
                .flags(flags)
                .value(self.paid[p as usize] as i32)
                .aux(self.to_call(p) as usize);
            obs.push(t);
        }

        for p in 0..n {
            let card = self.hole[p as usize];
            let mut t = Token::new(kind::CARD, zone::HAND).seat(r(p)).flags(1 << (r(p) - 1));
            if p == me || omniscient {
                t = t.face(card).value(card.rank() as i32);
            }
            obs.push(t);
        }
        if let Some(card) = self.table {
            let mut t = Token::new(kind::CARD, zone::TABLE);
            if self.table_shown() {
                t = t.flags((1 << n) - 1);
            }
            if self.table_shown() || omniscient {
                t = t.face(card).value(card.rank() as i32);
            }
            obs.push(t);
        }

        // The whole betting history, newest first.
        for (age, m) in self.history.iter().rev().enumerate() {
            let t = Token::new(kind::EVENT, game_code(G, EVENT_BASE + m.action as u16))
                .seat(r(m.seat))
                .slot(m.round as usize)
                .aux(age);
            obs.push(t);
        }

        for (i, v) in self.rules.scalar_tokens().into_iter().enumerate() {
            obs.push(Token::new(kind::RULE, game_code(G, RULE_BASE + i as u16)).value(v));
        }

        if self.to_act() == Some(me) {
            let mut legal = Vec::new();
            self.legal_actions(&mut legal);
            obs.actions.extend(legal.into_iter().map(|a| ActionToken::new(game_code(G, 1 + a as u16))));
        }
    }

    fn determinize(&self, me: Seat, rng: &mut Rng) -> Self {
        let mut g = self.clone();
        // Hidden from `me`: the other cards, the table card until it is
        // turned up, and the rest of the deck.
        let mut pool: Vec<Card> = g.deck.clone();
        pool.extend((0..self.n).filter(|&p| p != me).map(|p| g.hole[p as usize]));
        if !self.table_shown() {
            pool.extend(g.table);
        }
        rng.shuffle(&mut pool);
        for p in (0..self.n).filter(|&p| p != me) {
            g.hole[p as usize] = pool.pop().unwrap();
        }
        if !self.table_shown() && g.table.is_some() {
            g.table = pool.pop();
        }
        g.deck = pool;
        g
    }
}

impl Enumerable for MiniPoker {
    fn roots(rules: &MiniPokerRules, players: usize) -> Result<Vec<(Self, f64)>, String> {
        rules.validate(players)?;
        let deck = rules.deck();
        let dealt = players + (rules.rounds == 2) as usize;
        // Every ordered choice of the dealt cards, all equally likely.
        let mut deals: Vec<Vec<usize>> = vec![Vec::new()];
        for _ in 0..dealt {
            deals = deals
                .into_iter()
                .flat_map(|d| {
                    (0..deck.len()).filter(|i| !d.contains(i)).map(|i| [&d[..], &[i]].concat()).collect::<Vec<_>>()
                })
                .collect();
            if deals.len() > 200_000 {
                return Err("too many deals to list".into());
            }
        }
        let p = 1.0 / deals.len() as f64;
        Ok(deals
            .into_iter()
            .map(|d| {
                let mut cards: Vec<Card> = d.iter().map(|&i| deck[i]).collect();
                cards.extend((0..deck.len()).filter(|i| !d.contains(i)).map(|i| deck[i]));
                (MiniPoker::from_deal(rules, players, cards), p)
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exact::Tree;

    #[test]
    fn random_games_hold_the_invariants() {
        let report = crate::check::fuzz::<MiniPoker>(3000, 5, 2..=4, 200, |_, _| {}).unwrap();
        println!("{report:?}");
    }

    #[test]
    fn kuhn_is_solved_to_its_known_value() {
        let tree = Tree::build(MiniPoker::roots(&MiniPokerRules::kuhn(), 2).unwrap(), 100_000).unwrap();
        assert_eq!(tree.infosets.len(), 12);
        // A player who picks at random gives up 11/24 of a chip per hand.
        assert!((tree.exploitability(&tree.uniform()) - 11.0 / 24.0).abs() < 1e-9);
        let solved = tree.solve(20_000);
        let (value, gap) = (tree.values(&solved)[0], tree.exploitability(&solved));
        println!("Kuhn: first player's value {value:.5}, exploitability {gap:.6}");
        assert!((value + 1.0 / 18.0).abs() < 2e-3 && gap < 2e-3);
    }

    #[test]
    fn leduc_is_solved_to_its_known_value() {
        let tree = Tree::build(MiniPoker::roots(&MiniPokerRules::default(), 2).unwrap(), 1_000_000).unwrap();
        assert_eq!(tree.infosets.len(), 936);
        assert!((tree.exploitability(&tree.uniform()) - 4.747222 / 2.0).abs() < 1e-5);
        let solved = tree.solve(2_000);
        let (value, gap) = (tree.values(&solved)[0], tree.exploitability(&solved));
        println!("Leduc: first player's value {value:.5}, exploitability {gap:.6}");
        assert!((value + 0.0856).abs() < 5e-3 && gap < 5e-3);
    }
}
