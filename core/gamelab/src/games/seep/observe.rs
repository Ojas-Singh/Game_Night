//! Seep as the lab and the model see it: rule settings, observations and
//! re-dealing of hidden cards.

use super::*;
use crate::obs::{field, game_code, kind, rel, rel_mask, zone, ActionToken, Obs, Token};
use crate::settings::{Choice, Setting, SettingKind};

const G: u16 = 4;
const N: u8 = PLAYERS as u8;

/// What the observer is being asked to decide (global token, `SLOT` field).
#[derive(Clone, Copy)]
enum Decision {
    Waiting = 1,
    Announce,
    FirstPlay,
    Play,
    Over,
}

mod verb {
    pub const ANNOUNCE: u16 = 1;
    pub const LAY: u16 = 2;
    pub const CAPTURE: u16 = 3;
    pub const BUILD: u16 = 4;
    pub const ADD: u16 = 5;
    pub const BREAK: u16 = 6;
}

/// `SUB` codes of event tokens start here, rule tokens after them.
const EVENT_BASE: u16 = 1;
const RULE_BASE: u16 = 20;
/// A card inside a house; the house total travels in `AUX`.
const HOUSE_CARD: u16 = 40;
/// What a team has taken in this deal.
const TEAM_PILE: u16 = 41;
/// A team's sweeps in this deal.
const TEAM_SWEEPS: u16 = 42;
/// How many cards of one rank have been taken by anyone.
const TAKEN_RANK: u16 = 43;
/// A set of loose cards that one of the observer's moves would use.
const LOOSE_SET: u16 = 44;

/// Most recent events shown to the model.
const HISTORY: usize = 32;

impl SeepRules {
    fn scalar_tokens(&self) -> [i32; 13] {
        [
            self.opening_hand_cards as i32,
            self.table_start_cards as i32,
            self.cards_per_batch as i32,
            self.min_house_total as i32,
            self.max_house_total as i32,
            (self.sweep_bonus as i32 + 3) / 4,
            (self.first_play_sweep_bonus as i32 + 3) / 4,
            self.last_play_sweep_zero as i32,
            self.ten_diamonds_points as i32,
            self.majority_cards_bonus as i32,
            self.minimum_deal_points as i32,
            (self.baazi_lead_target as i32 + 7) / 8,
            self.dealer_policy as i32,
        ]
    }
}

impl Seep {
    fn decision(&self, me: Seat) -> Decision {
        if self.phase == Phase::MatchComplete {
            return Decision::Over;
        }
        if self.to_act() != Some(me) {
            return Decision::Waiting;
        }
        match self.phase {
            Phase::Announce => Decision::Announce,
            _ if self.plays_made == 0 => Decision::FirstPlay,
            _ => Decision::Play,
        }
    }

    /// A face-up card with its points under the rules in force.
    fn shown(&self, t: Token, card: Card) -> Token {
        t.face(card).value(self.rules.card_points(card))
    }

    fn event_token(&self, me: Seat, e: &SeepEvent, age: usize) -> Token {
        use SeepEvent::*;
        let ev = |i: u16, seat: Seat| Token::new(kind::EVENT, game_code(G, EVENT_BASE + i)).seat(rel(me, seat, N)).aux(age);
        match *e {
            DealStarted { dealer } => ev(0, dealer),
            Announced { seat, value } => ev(1, seat).rank(value),
            Laid { seat, card } => ev(2, seat).face(card),
            Captured { seat, card, count, houses } => ev(3, seat).face(card).value(count as i32).flags(houses as u16),
            Built { seat, card, total, merged } => ev(4, seat).face(card).value(total as i32).flags(merged as u16),
            Added { seat, card, total } => ev(5, seat).face(card).value(total as i32),
            // The old total travels in the slot field.
            Broke { seat, card, from, to } => ev(6, seat).face(card).value(to as i32).slot(from as usize),
            Cemented { total, count } => {
                Token::new(kind::EVENT, game_code(G, EVENT_BASE + 7)).rank(total).value(count as i32).aux(age)
            }
            Sweep { seat, bonus } => ev(8, seat).value((bonus as i32 + 3) / 4),
        }
    }

    pub(super) fn observe(&self, me: Seat, omniscient: bool, obs: &mut Obs) {
        obs.clear();
        let r = |s: Seat| rel(me, s, N);
        let rules = &self.rules;
        let my_team = team_of(me);
        let playing = matches!(self.phase, Phase::Announce | Phase::TurnPlay);

        // The table. The lead is the observer's team's, in thirtieths of the target.
        let lead = if my_team == 0 { self.baazi_lead } else { -self.baazi_lead };
        let mut global = Token::new(kind::GLOBAL, game_code(G, 0))
            .seat(r(self.turn))
            .rank(self.bid.unwrap_or(0))
            .value((lead * 30 / rules.baazi_lead_target as i32).clamp(-30, 30))
            .flags(self.deal_rest_pending as u16 | (self.sim as u16) << 1)
            .aux(self.plays_made as usize);
        global.0[field::SLOT] = self.decision(me) as u16;
        obs.push(global);

        // Players.
        for p in 0..N {
            let flags = (playing && p == self.turn) as u16
                | ((p == self.bidder) as u16) << 1
                | ((p == self.dealer) as u16) << 2
                | ((team_of(p) == my_team) as u16) << 3;
            obs.push(
                Token::new(kind::PLAYER, 0)
                    .seat(r(p))
                    .flags(flags)
                    .value(self.captures[p as usize].len() as i32)
                    .aux(self.hands[p as usize].len()),
            );
        }

        // Hands: the observer's own cards are open.
        let mut mine = Vec::new();
        for p in 0..N {
            for (i, &c) in self.hands[p as usize].iter().enumerate() {
                let mut t = Token::new(kind::CARD, zone::HAND).seat(r(p)).slot(i);
                if omniscient || p == me {
                    t = self.shown(t, c);
                }
                let at = obs.push(t);
                if p == me {
                    mine.push(at);
                }
            }
        }

        // The floor. Loose cards lie face down until the announce.
        let floor_open = omniscient || self.phase != Phase::Announce;
        for (i, &c) in self.loose.iter().enumerate() {
            let t = Token::new(kind::CARD, zone::TABLE).slot(i);
            obs.push(if floor_open { self.shown(t, c) } else { t });
        }
        let mut house_at = [0usize; 14];
        for (i, house) in self.houses.iter().enumerate() {
            let owners = house.owners.iter().flatten().fold(0u8, |m, &p| m | 1 << p);
            let points: i32 = house.cards.iter().map(|&c| rules.card_points(c)).sum();
            house_at[house.total as usize] = obs.push(
                Token::new(kind::PILE, zone::TABLE)
                    .slot(i)
                    .rank(house.total)
                    .value(points)
                    .flags(rel_mask(me, owners, N) | (house.pakka() as u16) << 4)
                    .aux(house.cards.len()),
            );
            for &c in &house.cards {
                let t = Token::new(kind::CARD, game_code(G, HOUSE_CARD)).slot(i).aux(house.total as usize);
                obs.push(self.shown(t, c));
            }
        }

        // The latest capture stays open until the next play.
        if let Some(pickup) = self.last_pickup.as_ref().filter(|p| p.plays_made == self.plays_made) {
            for &c in &pickup.cards {
                obs.push(self.shown(Token::new(kind::CARD, zone::CAPTURED).seat(r(pickup.seat)), c));
            }
        }

        // Piles: the deck, what each team has taken, and the ranks that are gone.
        obs.push(Token::new(kind::PILE, zone::DECK).aux(self.deck.len()));
        let points = self.card_points();
        for team in 0..2u8 {
            let side = (team == my_team) as u16 | ((self.last_capture_team == Some(team)) as u16) << 1;
            let t = team as usize;
            obs.push(
                Token::new(kind::PILE, game_code(G, TEAM_PILE))
                    .flags(side)
                    .value(self.captured_count(team) as i32)
                    .aux(points[t] as usize),
            );
            if self.sweeps[t] > 0 {
                obs.push(
                    Token::new(kind::PILE, game_code(G, TEAM_SWEEPS))
                        .flags(side)
                        .slot(self.sweeps[t] as usize)
                        .aux((self.sweep_points[t] as usize + 3) / 4),
                );
            }
        }
        let mut by_rank = [0usize; 13];
        for c in self.captures.iter().flatten() {
            by_rank[c.rank() as usize - 1] += 1;
        }
        for (i, &count) in by_rank.iter().enumerate() {
            if count > 0 {
                obs.push(Token::new(kind::PILE, game_code(G, TAKEN_RANK)).rank(i as u8 + 1).aux(count));
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

        // The observer's options. A move names its hand card, the house it
        // touches and the set of loose cards it uses; each such set gets a
        // token of its own (floor positions 1 to 8 as flags, size, sum).
        if self.sim && self.to_act() == Some(me) {
            let mut legal = Vec::new();
            self.legal_actions(&mut legal);
            let mut sets: Vec<(u32, usize)> = Vec::new();
            let mut set_at = |mask: u32, obs: &mut Obs| match sets.iter().find(|s| s.0 == mask) {
                Some(s) => s.1,
                None => {
                    let sum: i32 = bits(mask).map(|i| self.loose[i].rank() as i32).sum();
                    let t = Token::new(kind::PILE, game_code(G, LOOSE_SET))
                        .slot(mask.trailing_zeros() as usize)
                        .value(sum)
                        .flags(mask as u16)
                        .aux(mask.count_ones() as usize);
                    sets.push((mask, obs.push(t)));
                    sets[sets.len() - 1].1
                }
            };
            let a = |v: u16, slot: u8| ActionToken::new(game_code(G, v)).arg(0, mine[slot as usize]);
            for action in legal {
                use SeepAction::*;
                let hand = &self.hands[me as usize];
                let token = match action {
                    Announce { value } => {
                        let slot = hand.iter().position(|c| c.rank() == value).unwrap_or(0);
                        a(verb::ANNOUNCE, slot as u8).param(value as usize)
                    }
                    Lay { card } => a(verb::LAY, card),
                    Capture { card, loose } => {
                        let mut t = a(verb::CAPTURE, card);
                        let v = hand[card as usize].rank();
                        if self.house_of(v).is_some() {
                            t = t.arg(1, house_at[v as usize]);
                        }
                        if loose != 0 {
                            t = t.arg(2, set_at(loose, obs));
                        }
                        t
                    }
                    Build { card, loose, total } => {
                        let mut t = a(verb::BUILD, card).arg(2, set_at(loose, obs)).param(total as usize);
                        if self.house_of(total).is_some() {
                            t = t.arg(1, house_at[total as usize]);
                        }
                        t
                    }
                    Add { card, total, loose } => {
                        let t = a(verb::ADD, card).arg(1, house_at[total as usize]);
                        if loose != 0 {
                            t.arg(2, set_at(loose, obs))
                        } else {
                            t
                        }
                    }
                    Break { card, total } => {
                        let raised = total + hand[card as usize].rank();
                        a(verb::BREAK, card).arg(1, house_at[total as usize]).param(raised as usize)
                    }
                    NextDeal => continue,
                };
                obs.actions.push(token);
            }
        }
    }

    pub(super) fn determinize(&self, me: Seat, rng: &mut Rng) -> Seep {
        let mut g = self.clone();
        g.rng = rng.fork();
        if !matches!(self.phase, Phase::Announce | Phase::TurnPlay) {
            return g;
        }

        // Every card `me` cannot see: the other hands, the deck and, before
        // the announce, the floor. They are dealt again among the same places.
        let floor_hidden = self.phase == Phase::Announce;
        let mut pool: Vec<Card> = g.deck.clone();
        for p in (0..N).filter(|&p| p != me) {
            pool.extend(&g.hands[p as usize]);
        }
        if floor_hidden {
            pool.extend(&g.loose);
        }
        rng.shuffle(&mut pool);

        // What everyone knows about the other hands stays true: a player
        // holds a card for each house he answers for, and the bidder holds
        // the number he announced (or, before that, one he could announce).
        let others = || (0..N).filter(|&p| p != me);
        for p in others() {
            let hand = &mut g.hands[p as usize];
            let size = std::mem::take(hand).len();
            let mut take = |fits: &dyn Fn(u8) -> bool| {
                if let Some(i) = pool.iter().position(|c| fits(c.rank())) {
                    hand.push(pool.swap_remove(i));
                }
            };
            if size == 0 {
                continue;
            }
            for house in self.houses.iter().filter(|h| h.owned_by(p)) {
                take(&|rank| rank == house.total);
            }
            if p == self.bidder && self.plays_made == 0 {
                match self.bid {
                    Some(bid) => take(&|rank| rank == bid),
                    None => take(&|rank| self.rules.biddable(rank)),
                }
            }
        }
        for p in others() {
            let hand = &mut g.hands[p as usize];
            while hand.len() < self.hands[p as usize].len() {
                hand.extend(pool.pop());
            }
            rng.shuffle(hand);
        }
        if floor_hidden {
            for c in g.loose.iter_mut() {
                *c = pool.pop().expect("a card for every place");
            }
        }
        g.deck = pool;
        g
    }

    pub fn settings() -> Vec<Setting> {
        let (deal, houses, scoring, baazi) = ("Deal", "Houses", "Scoring", "Baazi");
        vec![
            Setting::int(deal, "openingHandCards", "Opening hand", "Cards the bidder holds when he announces.", 1, 12),
            Setting::int(deal, "tableStartCards", "Cards on the floor", "Cards dealt to the floor before the announce.", 0, 4),
            Setting::int(
                deal,
                "cardsPerBatch",
                "Cards dealt at a time",
                "How many cards a player gets at a time when the rest of the deck is dealt.",
                1,
                12,
            ),
            Setting::int(
                houses,
                "minHouseTotal",
                "Smallest house",
                "Smallest total a house, and the announce, may have. Must not exceed the largest.",
                2,
                13,
            ),
            Setting::int(houses, "maxHouseTotal", "Largest house", "Largest total a house, and the announce, may have.", 2, 13),
            Setting::int(scoring, "sweepBonus", "Sweep bonus", "Points for clearing the floor.", 0, 100),
            Setting::int(
                scoring,
                "firstPlaySweepBonus",
                "First-play sweep bonus",
                "Points for clearing the floor with the very first play.",
                0,
                100,
            ),
            Setting::bool(
                scoring,
                "lastPlaySweepZero",
                "Last-card sweep scores nothing",
                "A sweep made with the last card of the deal earns no bonus.",
            ),
            Setting::int(scoring, "tenDiamondsPoints", "Ten of diamonds", "Points for the ten of diamonds.", 0, 10),
            Setting::int(
                scoring,
                "majorityCardsBonus",
                "Most cards bonus",
                "Points for the team that took more cards; 0 for none.",
                0,
                10,
            ),
            Setting::int(
                baazi,
                "minimumDealPoints",
                "Minimum points per deal",
                "A team that scores less than this in a deal loses the baazi at once.",
                0,
                30,
            ),
            Setting::int(baazi, "baaziLeadTarget", "Lead that wins", "The baazi is won by leading by this many points.", 1, 300),
            Setting {
                key: "dealerPolicy",
                label: "Dealer",
                help: "Kept with the table; the rules do not use it yet.",
                group: baazi,
                kind: SettingKind::Choice {
                    options: vec![
                        Choice { value: json!("losing-team-stays"), label: "Losing team keeps the deal" },
                        Choice { value: json!("rotate-right"), label: "Deal passes to the right" },
                    ],
                },
            },
        ]
    }
}

impl Game for Seep {
    const ID: &'static str = "seep";
    const NUMBER: u16 = G;
    const PLAYERS: (usize, usize) = (4, 4);
    type Rules = SeepRules;
    type Action = SeepAction;

    fn new(rules: &SeepRules, players: usize, rng: Rng) -> Result<Self, String> {
        Seep::deal(rules, players, rng, true)
    }
    fn live(rules: &SeepRules, players: usize, rng: Rng) -> Result<Self, String> {
        Seep::deal(rules, players, rng, false)
    }
    fn players(&self) -> usize {
        PLAYERS
    }
    fn is_over(&self) -> bool {
        self.phase == Phase::MatchComplete
    }
    fn to_act(&self) -> Option<Seat> {
        Seep::to_act(self)
    }
    fn legal_actions(&self, out: &mut Vec<SeepAction>) {
        Seep::legal_actions(self, out)
    }
    fn apply(&mut self, seat: Seat, action: &SeepAction) -> Result<(), Illegal> {
        Seep::apply(self, seat, action)
    }
    /// A baazi is won or lost as a team, whatever the margin.
    fn returns(&self) -> Vec<f32> {
        match self.baazi_winner {
            Some(team) if self.is_over() => winner_returns(PLAYERS, &[team, team + 2]),
            _ => vec![0.0; PLAYERS],
        }
    }
    fn settings() -> Vec<Setting> {
        Seep::settings()
    }
    fn verbs() -> Vec<(u16, &'static str)> {
        vec![
            (verb::ANNOUNCE, "Announce"),
            (verb::LAY, "Lay a card"),
            (verb::CAPTURE, "Capture"),
            (verb::BUILD, "Build a house"),
            (verb::ADD, "Add to a house"),
            (verb::BREAK, "Break a house"),
        ]
    }
    fn stat_names() -> Vec<crate::game::Stat> {
        use crate::game::Stat;
        vec![
            Stat::new("deals", "Deals"),
            Stat::new("dealMargin", "Mean margin of a deal, in points"),
            Stat::new("dealPoints", "Mean points scored in a deal"),
            Stat::new("wonOnMinimum", "Decided by the minimum-points rule"),
            Stat::new("leadChanges", "Changes of the lead"),
        ]
    }
    fn stats(&self) -> Vec<f32> {
        let deals = self.deal_history.len().max(1) as f32;
        let margin: i32 = self.deal_history.iter().map(|d| d.diff.abs()).sum();
        let points: i32 = self.deal_history.iter().map(|d| d.team_scores[0] + d.team_scores[1]).sum();
        let leads: Vec<i32> = self.deal_history.iter().map(|d| d.lead_after.signum()).filter(|&s| s != 0).collect();
        vec![
            self.deal_history.len() as f32,
            margin as f32 / deals,
            points as f32 / deals,
            (self.baazi_reason == Some(BaaziReason::MinimumPoints)) as u8 as f32,
            leads.windows(2).filter(|w| w[0] != w[1]).count() as f32,
        ]
    }
    fn presets() -> Vec<(&'static str, SeepRules)> {
        vec![("Punjabi 100", SeepRules::default()), ("Casual", SeepRules::casual())]
    }
    fn observe(&self, seat: Seat, omniscient: bool, obs: &mut Obs) {
        Seep::observe(self, seat, omniscient, obs)
    }
    fn determinize(&self, seat: Seat, rng: &mut Rng) -> Self {
        Seep::determinize(self, seat, rng)
    }
    /// The same round; in simulation the next deal follows by itself.
    fn for_seat(&self, seat: Seat, reacting: bool, _rng: &mut Rng) -> Option<Self> {
        (!reacting && self.to_act() == Some(seat)).then(|| Seep { sim: true, ..self.clone() })
    }
}
