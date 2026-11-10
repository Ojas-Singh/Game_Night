//! Seep (Punjabi, played to a lead of 100): two teams of two fish cards off
//! the floor.
//!
//! Partners sit opposite each other and play runs to the right. The player on
//! the dealer's right gets a short opening hand, announces a number that he
//! holds, and makes the first play with it; then the rest of the deck is dealt.
//! Each turn a player plays one card: it takes loose cards that add up to its
//! rank and every house of that total, or it builds loose cards into a house,
//! adds another set to a house (which cements it), raises another player's
//! single house, or is simply laid on the floor. A card that can take
//! something may not be laid. Whoever answers for a house must keep a card of
//! its total in hand while it stands.
//!
//! Spades score their rank, the other aces 1 and the ten of diamonds 6;
//! clearing the floor is a sweep worth a bonus. The difference between the
//! teams' points is carried from deal to deal until one team leads by the
//! target, which wins the baazi. A team that falls short of the minimum in a
//! deal loses the baazi at once.
//!
//! On the live site the next deal starts when someone asks for it. In
//! simulation mode it is dealt at once, and the game ends with the baazi.

use crate::cards::{standard_deck, Card, Suit};
use crate::game::{winner_returns, Game, Illegal, Seat};
use crate::rng::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

mod observe;

pub const PLAYERS: usize = 4;
/// Cards each player has held once the whole deck is out.
const CARDS_PER_PLAYER: usize = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DealerPolicy {
    LosingTeamStays,
    RotateRight,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SeepRules {
    /// Cards the bidder holds when he announces.
    pub opening_hand_cards: u8,
    /// Cards dealt to the floor before the announce.
    pub table_start_cards: u8,
    /// Cards a player receives at a time when the rest of the deck is dealt.
    pub cards_per_batch: u8,
    /// Smallest and largest total a house (and the announce) may have.
    pub min_house_total: u8,
    pub max_house_total: u8,
    /// Points for clearing the floor.
    pub sweep_bonus: u16,
    /// Points for clearing the floor with the very first play.
    pub first_play_sweep_bonus: u16,
    /// A sweep made with the last card of the deal scores nothing.
    pub last_play_sweep_zero: bool,
    /// Points for the ten of diamonds.
    pub ten_diamonds_points: u8,
    /// Points for the team that took more cards; 0 for none.
    pub majority_cards_bonus: u8,
    /// A team that scores less than this in a deal loses the baazi.
    pub minimum_deal_points: u16,
    /// Lead that wins the baazi.
    pub baazi_lead_target: u16,
    /// Stored with the table but not used by the rules: the dealer always
    /// stays while his team is not ahead.
    pub dealer_policy: DealerPolicy,
}

impl Default for SeepRules {
    fn default() -> Self {
        SeepRules {
            opening_hand_cards: 4,
            table_start_cards: 4,
            cards_per_batch: 4,
            min_house_total: 9,
            max_house_total: 13,
            sweep_bonus: 50,
            first_play_sweep_bonus: 25,
            last_play_sweep_zero: true,
            ten_diamonds_points: 6,
            majority_cards_bonus: 0,
            minimum_deal_points: 9,
            baazi_lead_target: 100,
            dealer_policy: DealerPolicy::LosingTeamStays,
        }
    }
}

impl SeepRules {
    /// The friendlier table: the ten of diamonds is worth 2, most cards earns
    /// 4, and a sweep with the last card counts.
    pub fn casual() -> SeepRules {
        SeepRules { ten_diamonds_points: 2, majority_cards_bonus: 4, last_play_sweep_zero: false, ..Default::default() }
    }

    pub fn card_points(&self, c: Card) -> i32 {
        match (c.suit(), c.rank()) {
            (Suit::Spades, rank) => rank as i32,
            (_, 1) => 1,
            (Suit::Diamonds, 10) => self.ten_diamonds_points as i32,
            _ => 0,
        }
    }

    fn biddable(&self, rank: u8) -> bool {
        (self.min_house_total..=self.max_house_total).contains(&rank)
    }

    pub fn validate(&self, players: usize) -> Result<(), String> {
        if players != PLAYERS {
            return Err("Seep needs exactly 4 players".into());
        }
        if !(1..=CARDS_PER_PLAYER as u8).contains(&self.opening_hand_cards) {
            return Err("openingHandCards must be 1 to 12".into());
        }
        if self.table_start_cards > 4 {
            return Err("tableStartCards must be 0 to 4".into());
        }
        if !(1..=CARDS_PER_PLAYER as u8).contains(&self.cards_per_batch) {
            return Err("cardsPerBatch must be 1 to 12".into());
        }
        if self.min_house_total < 2 || self.max_house_total > 13 || self.min_house_total > self.max_house_total {
            return Err("house totals must lie within 2 to 13, smallest first".into());
        }
        if self.sweep_bonus > 100 || self.first_play_sweep_bonus > 100 {
            return Err("sweep bonuses must be 0 to 100".into());
        }
        if self.ten_diamonds_points > 10 || self.majority_cards_bonus > 10 {
            return Err("tenDiamondsPoints and majorityCardsBonus must be 0 to 10".into());
        }
        if self.minimum_deal_points > 30 {
            return Err("minimumDealPoints must be 0 to 30".into());
        }
        if !(1..=300).contains(&self.baazi_lead_target) {
            return Err("baaziLeadTarget must be 1 to 300".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Phase {
    Announce,
    TurnPlay,
    DealComplete,
    MatchComplete,
}

/// Cards on the floor are addressed by position, one bit per loose card.
/// A house is addressed by its total: no two houses share one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SeepAction {
    /// The bidder names a rank he holds; his first play must involve it.
    Announce { value: u8 },
    /// Put a card on the floor.
    Lay { card: u8 },
    /// Take the loose cards in `loose` and every house matching the card.
    Capture { card: u8, loose: u32 },
    /// Join the card and the loose cards in `loose` into a house of `total`.
    Build { card: u8, loose: u32, total: u8 },
    /// Add one more set (the card plus `loose`) to the house of `total`.
    Add { card: u8, total: u8, loose: u32 },
    /// Raise another player's single house of `total` by the card's rank.
    Break { card: u8, total: u8 },
    /// Start the next deal (live site only).
    NextDeal,
}

impl SeepAction {
    /// Hand position of the card a play uses.
    fn card(&self) -> Option<u8> {
        use SeepAction::*;
        match *self {
            Lay { card } | Capture { card, .. } | Build { card, .. } | Add { card, .. } | Break { card, .. } => {
                Some(card)
            }
            Announce { .. } | NextDeal => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct House {
    /// Number in order of creation within the deal, from 1.
    pub id: u16,
    pub total: u8,
    /// The player of each team who answers for the house.
    pub owners: [Option<Seat>; 2],
    pub cards: Vec<Card>,
}

impl House {
    /// How many complete sets of the total the house holds.
    pub fn copies(&self) -> u32 {
        let sum: u32 = self.cards.iter().map(|c| c.rank() as u32).sum();
        (2 * sum + self.total as u32) / (2 * self.total as u32)
    }

    /// A cemented house: two or more sets, which nobody can raise.
    pub fn pakka(&self) -> bool {
        self.copies() >= 2
    }

    fn owned_by(&self, seat: Seat) -> bool {
        self.owners.contains(&Some(seat))
    }
}

/// The cards of the latest capture, which stay open until the next play.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pickup {
    pub seat: Seat,
    pub cards: Vec<Card>,
    pub plays_made: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BaaziReason {
    Lead,
    MinimumPoints,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DealResult {
    pub deal_no: u32,
    pub team_scores: [i32; 2],
    /// Team 0's points minus team 1's.
    pub diff: i32,
    /// The team that took the cards left on the floor.
    pub leftover_team: Option<u8>,
    pub baazi: Option<(u8, BaaziReason)>,
    pub lead_after: i32,
    pub baazis_won_after: [u32; 2],
}

/// What the players saw happen in the current deal, oldest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SeepEvent {
    DealStarted { dealer: Seat },
    Announced { seat: Seat, value: u8 },
    Laid { seat: Seat, card: Card },
    Captured { seat: Seat, card: Card, count: u8, houses: u8 },
    Built { seat: Seat, card: Card, total: u8, merged: bool },
    Added { seat: Seat, card: Card, total: u8 },
    Broke { seat: Seat, card: Card, from: u8, to: u8 },
    /// Loose cards joined a house by themselves.
    Cemented { total: u8, count: u8 },
    Sweep { seat: Seat, bonus: u16 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Seep {
    pub rules: SeepRules,
    pub phase: Phase,
    pub hands: Vec<Vec<Card>>,
    /// Loose cards on the floor. Face down until the announce.
    pub loose: Vec<Card>,
    pub houses: Vec<House>,
    /// Top of the deck is the end of the vector.
    pub deck: Vec<Card>,
    pub bidder: Seat,
    pub dealer: Seat,
    pub deal_no: u32,
    pub bid: Option<u8>,
    /// The rest of the deck is dealt after the bidder's first play.
    pub deal_rest_pending: bool,
    pub batches_dealt: u16,
    /// Shuffles thrown away before this deal because the bidder had nothing to announce.
    #[serde(default)]
    pub redeals: u16,
    pub plays_made: u16,
    /// Cards each seat has taken.
    pub captures: Vec<Vec<Card>>,
    pub sweeps: [u32; 2],
    pub sweep_points: [i32; 2],
    pub last_capture_team: Option<u8>,
    pub last_pickup: Option<Pickup>,
    pub turn: Seat,
    pub house_seq: u16,
    /// Running lead of team 0 over team 1 (negative when team 1 leads).
    pub baazi_lead: i32,
    pub baazis_won: [u32; 2],
    pub deal_history: Vec<DealResult>,
    /// Set when a deal has been scored.
    pub team_scores: Option<[i32; 2]>,
    pub round_winner: Option<u8>,
    pub baazi_winner: Option<u8>,
    pub baazi_reason: Option<BaaziReason>,
    /// Counters the live site uses to order its updates.
    pub event_seq: u32,
    pub revision: u32,
    pub log: Vec<SeepEvent>,
    /// Simulation mode: the next deal starts by itself.
    pub sim: bool,
    rng: Rng,
}

type Check = Result<(), Illegal>;

fn no(msg: &'static str) -> Check {
    Err(Illegal(msg))
}

pub fn team_of(seat: Seat) -> u8 {
    seat % 2
}

/// Play runs counter-clockwise: the next seat is the one to the right.
pub fn right_of(seat: Seat) -> Seat {
    (seat + 3) % 4
}

fn bits(mask: u32) -> impl Iterator<Item = usize> {
    (0..32).filter(move |i| mask >> i & 1 == 1)
}

/// Whether some of `ranks` add up to exactly `target`.
fn reachable(ranks: impl Iterator<Item = u8>, target: u8) -> bool {
    let mut sums = 1u32;
    for r in ranks {
        sums |= sums << r & 0x3fff;
    }
    sums >> target & 1 == 1
}

/// Whether `ranks` split into sets that each add up to `target`.
fn splits_into(ranks: &[u8], target: u8) -> bool {
    fn fill(ranks: &[u8], used: u32, from: usize, need: u8, target: u8) -> bool {
        if need == 0 {
            return search(ranks, used, target);
        }
        (from..ranks.len()).any(|j| {
            used >> j & 1 == 0 && ranks[j] <= need && fill(ranks, used | 1 << j, j + 1, need - ranks[j], target)
        })
    }
    fn search(ranks: &[u8], used: u32, target: u8) -> bool {
        match (0..ranks.len()).find(|&i| used >> i & 1 == 0) {
            None => true,
            Some(first) => {
                ranks[first] <= target && fill(ranks, used | 1 << first, first + 1, target - ranks[first], target)
            }
        }
    }
    !ranks.is_empty() && search(ranks, 0, target)
}

/// Every way a card of rank `target` can take loose cards: each alternative
/// is a list of disjoint sets (bit per floor position) that each add up to
/// `target`, and leaves no further set among the cards it does not take.
/// The player must take one whole alternative.
pub fn capture_alternatives(ranks: &[u8], target: u8) -> Vec<Vec<u32>> {
    let n = ranks.len();
    let mut sets: Vec<u32> = Vec::new();
    fn collect(ranks: &[u8], target: u8, start: usize, mask: u32, sum: u8, sets: &mut Vec<u32>) {
        if sum == target && mask != 0 {
            sets.push(mask);
            return;
        }
        for j in start..ranks.len() {
            if sum + ranks[j] <= target {
                collect(ranks, target, j + 1, mask | 1 << j, sum + ranks[j], sets);
            }
        }
    }
    let mut out = Vec::new();
    if n == 0 || target < 1 {
        return out;
    }
    collect(ranks, target, 0, 0, 0, &mut sets);
    if sets.is_empty() {
        return out;
    }
    // Take the lowest undecided card with one of its sets, or leave it.
    fn search(n: usize, sets: &[u32], used: u32, left: u32, groups: &mut Vec<u32>, out: &mut Vec<Vec<u32>>) {
        let Some(i) = (0..n).find(|&i| (used | left) >> i & 1 == 0) else {
            if sets.iter().all(|&g| g & used != 0) {
                out.push(groups.clone());
            }
            return;
        };
        for &g in sets {
            if g & (used | left) == 0 && g >> i & 1 == 1 {
                groups.push(g);
                search(n, sets, used | g, left, groups, out);
                groups.pop();
            }
        }
        search(n, sets, used, left | 1 << i, groups, out);
    }
    search(n, &sets, 0, 0, &mut Vec::new(), &mut out);
    out
}

impl Seep {
    /// A new match. `sim` selects simulation mode (see the module text).
    pub fn deal(rules: &SeepRules, players: usize, mut rng: Rng, sim: bool) -> Result<Seep, String> {
        rules.validate(players)?;
        let dealer = rng.int(PLAYERS) as Seat;
        let mut state = Seep {
            rules: rules.clone(),
            phase: Phase::Announce,
            hands: vec![Vec::with_capacity(CARDS_PER_PLAYER); PLAYERS],
            loose: Vec::new(),
            houses: Vec::new(),
            deck: Vec::new(),
            bidder: 0,
            dealer,
            deal_no: 0,
            bid: None,
            deal_rest_pending: true,
            batches_dealt: 0,
            redeals: 0,
            plays_made: 0,
            captures: vec![Vec::new(); PLAYERS],
            sweeps: [0; 2],
            sweep_points: [0; 2],
            last_capture_team: None,
            last_pickup: None,
            turn: 0,
            house_seq: 0,
            baazi_lead: 0,
            baazis_won: [0; 2],
            deal_history: Vec::new(),
            team_scores: None,
            round_winner: None,
            baazi_winner: None,
            baazi_reason: None,
            event_seq: 0,
            revision: 1,
            log: Vec::new(),
            sim,
            rng,
        };
        state.tick();
        state.start_deal(dealer);
        Ok(state)
    }

    fn loose_ranks(&self) -> Vec<u8> {
        self.loose.iter().map(|c| c.rank()).collect()
    }

    fn house_of(&self, total: u8) -> Option<usize> {
        self.houses.iter().position(|h| h.total == total)
    }

    /// Card points each team has taken so far in this deal.
    pub fn card_points(&self) -> [i32; 2] {
        let mut points = [0; 2];
        for (seat, pile) in self.captures.iter().enumerate() {
            points[seat % 2] += pile.iter().map(|&c| self.rules.card_points(c)).sum::<i32>();
        }
        points
    }

    pub fn captured_count(&self, team: u8) -> usize {
        self.captures[team as usize].len() + self.captures[team as usize + 2].len()
    }

    // ---------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------

    /// Whether `seat` may do `action` now. Does not change anything.
    pub fn check(&self, seat: Seat, action: &SeepAction) -> Check {
        if seat as usize >= PLAYERS {
            return no("player not in this game");
        }
        match *action {
            SeepAction::NextDeal => match self.phase {
                Phase::DealComplete => Ok(()),
                Phase::MatchComplete => no("the baazi is over"),
                _ => no("the current deal is still running"),
            },
            SeepAction::Announce { value } => {
                if self.phase != Phase::Announce {
                    return no("not the announce phase");
                }
                if seat != self.turn {
                    return no("only the bidder announces");
                }
                if !self.rules.biddable(value) {
                    return no("announce a number a house may have");
                }
                if !self.hands[seat as usize].iter().any(|c| c.rank() == value) {
                    return no("you must hold the card you announce");
                }
                Ok(())
            }
            _ => {
                if self.phase != Phase::TurnPlay {
                    return no("not the play phase");
                }
                if seat != self.turn {
                    return no("not your turn");
                }
                self.check_play(seat, action)
            }
        }
    }

    fn check_play(&self, seat: Seat, action: &SeepAction) -> Check {
        use SeepAction::*;
        let hand = &self.hands[seat as usize];
        let Some(&played) = action.card().and_then(|slot| hand.get(slot as usize)) else {
            return no("card not in your hand");
        };
        let v = played.rank();
        let team = team_of(seat) as usize;
        let Some(bid) = self.bid else {
            return no("no announce yet");
        };

        // The opening play must involve the announced number.
        if self.plays_made == 0 {
            match *action {
                Capture { .. } | Lay { .. } if v != bid => return no("the first play must use the announced card"),
                Build { total, .. } if total != bid => return no("the first play must build the announced number"),
                Add { .. } | Break { .. } => return no("there are no houses on the opening play"),
                _ => {}
            }
        }

        // Ranks left in hand after the play.
        let mut held = [0u8; 14];
        for c in hand {
            held[c.rank() as usize] += 1;
        }
        held[v as usize] -= 1;
        let holds = |total: u8| held[total as usize] > 0;
        let on_floor = |mask: u32| mask.checked_shr(self.loose.len() as u32).unwrap_or(0) == 0;
        let sum_of = |mask: u32| bits(mask).map(|i| self.loose[i].rank() as u32).sum::<u32>();

        match *action {
            Lay { .. } => {
                if self.house_of(v).is_some() || reachable(self.loose.iter().map(|c| c.rank()), v) {
                    return no("this card can take something, so it cannot be laid");
                }
            }
            Capture { loose, .. } => {
                if !on_floor(loose) {
                    return no("card not on the table");
                }
                if loose == 0 && self.house_of(v).is_none() {
                    return no("nothing to capture");
                }
                let alternatives = capture_alternatives(&self.loose_ranks(), v);
                let taken = |groups: &Vec<u32>| groups.iter().fold(0, |m, g| m | g);
                if loose == 0 {
                    if !alternatives.is_empty() {
                        return no("a card must take every loose set it matches");
                    }
                } else if !alternatives.iter().any(|groups| taken(groups) == loose) {
                    return no("you must take a maximal set of table cards");
                }
            }
            Build { loose, total, .. } => {
                if !on_floor(loose) {
                    return no("card not on the table");
                }
                if !self.rules.biddable(total) {
                    return no("a house cannot have that total");
                }
                if loose == 0 {
                    return no("a build takes at least one loose card");
                }
                let mut ranks = vec![v];
                ranks.extend(bits(loose).map(|i| self.loose[i].rank()));
                if !splits_into(&ranks, total) {
                    return no("the build does not form complete sets of the house total");
                }
                // A new house, or one the team has no part in yet, must be
                // backed by a card of its total.
                let ours = self.house_of(total).is_some_and(|h| self.houses[h].owners[team].is_some());
                if !ours && !holds(total) {
                    return no("you must hold a card of the house total");
                }
            }
            Add { total, loose, .. } => {
                let Some(h) = self.house_of(total) else {
                    return no("no such house");
                };
                if !on_floor(loose) {
                    return no("card not on the table");
                }
                if v as u32 + sum_of(loose) != total as u32 {
                    return no("the cards you add must make one more set of the house total");
                }
                if self.houses[h].owners[team].is_none() && !holds(total) {
                    return no("you must keep a card of the total to cement an opponent's house");
                }
            }
            Break { total, .. } => {
                let Some(h) = self.house_of(total) else {
                    return no("no such house");
                };
                let house = &self.houses[h];
                if house.copies() != 1 {
                    return no("a cemented house cannot be raised");
                }
                if house.owners[team] == Some(seat) {
                    return no("you cannot raise your own house");
                }
                if total + v > self.rules.max_house_total {
                    return no("a house cannot exceed the largest total");
                }
                if !holds(total + v) {
                    return no("you must hold a card of the new total");
                }
            }
            Announce { .. } | NextDeal => unreachable!(),
        }

        // A player keeps a card for every house he answers for, unless this
        // was his last card. Houses taken by this play no longer count.
        let captured = if matches!(action, Capture { .. }) { v } else { 0 };
        let hand_empty = hand.len() == 1;
        for house in &self.houses {
            if house.total != captured && house.owned_by(seat) && !hand_empty && !holds(house.total) {
                return no("a card of the house total must stay in your hand");
            }
        }
        Ok(())
    }

    // ---------------------------------------------------------------
    // Simulation interface
    // ---------------------------------------------------------------

    pub fn to_act(&self) -> Option<Seat> {
        match self.phase {
            Phase::Announce | Phase::TurnPlay => Some(self.turn),
            Phase::DealComplete | Phase::MatchComplete => None,
        }
    }

    /// Every action `to_act` may take: announces in rising order, then for
    /// each hand card lay, captures, builds, additions and raises.
    pub fn legal_actions(&self, out: &mut Vec<SeepAction>) {
        use SeepAction::*;
        out.clear();
        let Some(seat) = self.to_act() else { return };
        let hand = &self.hands[seat as usize];
        if self.phase == Phase::Announce {
            for value in self.rules.min_house_total..=self.rules.max_house_total {
                if hand.iter().any(|c| c.rank() == value) {
                    out.push(Announce { value });
                }
            }
            return;
        }

        let ranks = self.loose_ranks();
        // Loose sets a card of each rank must choose between, worked out once per rank.
        let mut takes: [Option<Vec<u32>>; 14] = Default::default();
        // Non-empty sets of loose cards with their sums, in the order builds are listed.
        let mut subsets: Vec<(u32, u32)> = Vec::new();
        fn grow(ranks: &[u8], start: usize, mask: u32, sum: u32, subsets: &mut Vec<(u32, u32)>) {
            if mask != 0 {
                subsets.push((mask, sum));
            }
            for j in start..ranks.len() {
                grow(ranks, j + 1, mask | 1 << j, sum + ranks[j] as u32, subsets);
            }
        }
        grow(&ranks, 0, 0, 0, &mut subsets);

        for slot in 0..hand.len() as u8 {
            let v = hand[slot as usize].rank();
            let first = out.len();
            out.push(Lay { card: slot });

            let unions = takes[v as usize].get_or_insert_with(|| {
                let mut unions: Vec<u32> = Vec::new();
                for groups in capture_alternatives(&ranks, v) {
                    let taken = groups.iter().fold(0, |m, g| m | g);
                    if !unions.contains(&taken) {
                        unions.push(taken);
                    }
                }
                unions
            });
            if unions.is_empty() {
                out.push(Capture { card: slot, loose: 0 });
            } else {
                out.extend(unions.iter().map(|&loose| Capture { card: slot, loose }));
            }

            let v32 = v as u32;
            for &(loose, sum) in &subsets {
                for total in self.rules.min_house_total..=self.rules.max_house_total {
                    if (v32 + sum) % total as u32 == 0 {
                        out.push(Build { card: slot, loose, total });
                    }
                }
            }
            for house in &self.houses {
                if house.total == v {
                    out.push(Add { card: slot, total: v, loose: 0 });
                } else if house.total > v {
                    let need = (house.total - v) as u32;
                    out.extend(
                        subsets.iter().filter(|s| s.1 == need).map(|s| Add { card: slot, total: house.total, loose: s.0 }),
                    );
                }
            }
            for house in &self.houses {
                out.push(Break { card: slot, total: house.total });
            }

            // Keep the candidates the rules accept.
            let mut kept = first;
            for i in first..out.len() {
                if self.check_play(seat, &out[i]).is_ok() {
                    out.swap(kept, i);
                    kept += 1;
                }
            }
            out.truncate(kept);
        }
    }

    // ---------------------------------------------------------------
    // Mutation
    // ---------------------------------------------------------------

    pub fn apply(&mut self, seat: Seat, action: &SeepAction) -> Check {
        self.check(seat, action)?;
        match *action {
            SeepAction::NextDeal => self.next_deal(),
            SeepAction::Announce { value } => {
                self.bid = Some(value);
                self.phase = Phase::TurnPlay;
                self.revision += 1;
                self.emit(SeepEvent::Announced { seat, value });
                self.tick();
            }
            _ => {
                self.play(seat, action);
                self.revision += 1;
                self.after_play();
            }
        }
        Ok(())
    }

    /// One update on the live site that the event history does not keep.
    fn tick(&mut self) {
        self.event_seq += 1;
        self.revision += 1;
    }

    fn emit(&mut self, e: SeepEvent) {
        self.log.push(e);
        self.tick();
    }

    fn start_deal(&mut self, dealer: Seat) {
        self.dealer = dealer;
        self.bidder = right_of(dealer);
        self.deal_no += 1;
        self.phase = Phase::Announce;
        self.bid = None;
        self.deal_rest_pending = true;
        self.batches_dealt = 0;
        self.plays_made = 0;
        self.loose.clear();
        self.houses.clear();
        self.sweeps = [0; 2];
        self.sweep_points = [0; 2];
        self.last_capture_team = None;
        self.last_pickup = None;
        self.turn = self.bidder;
        self.house_seq = 0;
        self.team_scores = None;
        self.round_winner = None;
        self.baazi_winner = None;
        self.baazi_reason = None;
        for pile in self.hands.iter_mut().chain(self.captures.iter_mut()) {
            pile.clear();
        }
        self.log.clear();

        // The bidder must be able to announce: deal again until one of his
        // opening cards is a number a house may have.
        let opening = self.rules.opening_hand_cards as usize;
        let mut deck = standard_deck(1);
        self.rng.shuffle(&mut deck);
        self.redeals = 0;
        while !deck[deck.len() - opening..].iter().any(|c| self.rules.biddable(c.rank())) {
            deck = standard_deck(1);
            self.rng.shuffle(&mut deck);
            self.redeals += 1;
        }
        self.emit(SeepEvent::DealStarted { dealer });
        if self.redeals > 0 {
            self.tick();
        }
        for _ in 0..opening {
            self.hands[self.bidder as usize].extend(deck.pop());
        }
        for _ in 0..self.rules.table_start_cards {
            self.loose.extend(deck.pop());
        }
        self.deck = deck;
        self.tick();
    }

    /// Remove the loose cards in `mask` from the floor, in floor order.
    fn take_loose(&mut self, mask: u32) -> Vec<Card> {
        let taken = bits(mask).map(|i| self.loose[i]).collect();
        let mut i = 0;
        self.loose.retain(|_| {
            i += 1;
            mask >> (i - 1) & 1 == 0
        });
        taken
    }

    fn play(&mut self, seat: Seat, action: &SeepAction) {
        use SeepAction::*;
        let slot = action.card().expect("a play names a hand card") as usize;
        let card = self.hands[seat as usize].remove(slot);
        let v = card.rank();
        let team = team_of(seat);
        self.plays_made += 1;
        match *action {
            Lay { .. } => {
                self.loose.push(card);
                self.emit(SeepEvent::Laid { seat, card });
            }
            Capture { loose, .. } => {
                let mut pile = vec![card];
                pile.extend(self.take_loose(loose));
                let mut houses = 0;
                while let Some(h) = self.house_of(v) {
                    pile.extend(self.houses.remove(h).cards);
                    houses += 1;
                }
                self.captures[seat as usize].extend(&pile);
                self.last_capture_team = Some(team);
                self.emit(SeepEvent::Captured { seat, card, count: pile.len() as u8, houses });
                self.last_pickup = Some(Pickup { seat, cards: pile, plays_made: self.plays_made });
                if self.loose.is_empty() && self.houses.is_empty() {
                    self.sweep(seat);
                }
            }
            Build { loose, total, .. } => {
                let mut joined = vec![card];
                joined.extend(self.take_loose(loose));
                let (h, merged) = match self.house_of(total) {
                    Some(h) => {
                        self.houses[h].cards.extend(joined);
                        self.houses[h].owners[team as usize].get_or_insert(seat);
                        (h, true)
                    }
                    None => {
                        self.house_seq += 1;
                        let mut owners = [None; 2];
                        owners[team as usize] = Some(seat);
                        self.houses.push(House { id: self.house_seq, total, owners, cards: joined });
                        (self.houses.len() - 1, false)
                    }
                };
                self.emit(SeepEvent::Built { seat, card, total, merged });
                self.auto_cement(h);
            }
            Add { total, loose, .. } => {
                let taken = self.take_loose(loose);
                let h = self.house_of(total).expect("checked");
                let house = &mut self.houses[h];
                house.cards.push(card);
                house.cards.extend(taken);
                house.owners[team as usize].get_or_insert(seat);
                self.emit(SeepEvent::Added { seat, card, total });
            }
            Break { total, .. } => {
                let raised = total + v;
                // A house that already has the new total joins the raised one.
                let twin = self.house_of(raised).map(|t| self.houses.remove(t));
                let h = self.house_of(total).expect("checked");
                let house = &mut self.houses[h];
                house.total = raised;
                house.cards.push(card);
                house.owners = [None; 2];
                house.owners[team as usize] = Some(seat);
                if let Some(twin) = twin {
                    house.cards.extend(twin.cards);
                    for t in 0..2 {
                        house.owners[t] = house.owners[t].or(twin.owners[t]);
                    }
                }
                self.emit(SeepEvent::Broke { seat, card, from: total, to: raised });
                self.auto_cement(h);
            }
            Announce { .. } | NextDeal => unreachable!(),
        }
    }

    /// Loose cards that match a house just built or raised join it: first
    /// the cards of its total, then the first maximal choice of sets.
    fn auto_cement(&mut self, h: usize) {
        let total = self.houses[h].total;
        let before = self.houses[h].cards.len();
        let equal = (0..self.loose.len()).filter(|&i| self.loose[i].rank() == total).fold(0, |m, i| m | 1 << i);
        let cards = self.take_loose(equal);
        self.houses[h].cards.extend(cards);
        if let Some(groups) = capture_alternatives(&self.loose_ranks(), total).first() {
            let mut all = 0;
            for &g in groups {
                self.houses[h].cards.extend(bits(g).map(|i| self.loose[i]));
                all |= g;
            }
            self.take_loose(all);
        }
        let count = (self.houses[h].cards.len() - before) as u8;
        if count > 0 {
            self.emit(SeepEvent::Cemented { total, count });
        }
    }

    /// The floor was cleared by a capture.
    fn sweep(&mut self, seat: Seat) {
        let last_card = !self.deal_rest_pending && self.hands.iter().all(|h| h.is_empty());
        let bonus = if self.plays_made == 1 {
            self.rules.first_play_sweep_bonus
        } else if self.rules.last_play_sweep_zero && last_card {
            0
        } else {
            self.rules.sweep_bonus
        };
        let team = team_of(seat) as usize;
        self.sweeps[team] += 1;
        self.sweep_points[team] += bonus as i32;
        self.emit(SeepEvent::Sweep { seat, bonus });
    }

    fn after_play(&mut self) {
        if self.deal_rest_pending {
            self.deal_rest();
        }
        if self.hands.iter().all(|h| h.is_empty()) {
            self.finish_deal();
            if self.sim && self.phase == Phase::DealComplete {
                self.next_deal();
            }
        } else {
            self.turn = right_of(self.turn);
            self.tick();
        }
    }

    /// Deal out the deck after the first play, a batch at a time starting
    /// with the bidder, until everyone has held twelve cards.
    fn deal_rest(&mut self) {
        let bidder = self.bidder;
        let target = |seat: Seat| CARDS_PER_PLAYER - (seat == bidder) as usize;
        while (0..PLAYERS as Seat).any(|p| self.hands[p as usize].len() < target(p)) {
            let mut seat = self.bidder;
            for _ in 0..PLAYERS {
                let want = target(seat);
                let hand = &mut self.hands[seat as usize];
                for _ in 0..self.rules.cards_per_batch {
                    if hand.len() < want {
                        hand.extend(self.deck.pop());
                    }
                }
                seat = right_of(seat);
            }
            self.batches_dealt += 1;
            self.tick();
        }
        self.deal_rest_pending = false;
    }

    fn finish_deal(&mut self) {
        // What is left on the floor goes to the team that captured last.
        if let Some(team) = self.last_capture_team {
            let pile = &mut self.captures[team as usize];
            pile.append(&mut self.loose);
            pile.extend(self.houses.drain(..).flat_map(|h| h.cards));
        }
        self.loose.clear();
        self.houses.clear();

        let mut tp = self.card_points();
        tp[0] += self.sweep_points[0];
        tp[1] += self.sweep_points[1];
        let (c0, c1) = (self.captured_count(0), self.captured_count(1));
        if self.rules.majority_cards_bonus > 0 && c0 != c1 {
            tp[(c1 > c0) as usize] += self.rules.majority_cards_bonus as i32;
        }
        self.team_scores = Some(tp);
        self.round_winner = match tp[0].cmp(&tp[1]) {
            std::cmp::Ordering::Greater => Some(0),
            std::cmp::Ordering::Less => Some(1),
            std::cmp::Ordering::Equal => None,
        };

        let min = self.rules.minimum_deal_points as i32;
        let mut baazi = None;
        if tp[0] < min || tp[1] < min {
            // If both fall short, the team with more points takes it.
            let winner = if tp[0] < min && tp[1] < min { (tp[0] < tp[1]) as u8 } else { (tp[0] < min) as u8 };
            baazi = Some((winner, BaaziReason::MinimumPoints));
        } else {
            self.baazi_lead += tp[0] - tp[1];
            if self.baazi_lead.abs() >= self.rules.baazi_lead_target as i32 {
                baazi = Some(((self.baazi_lead <= 0) as u8, BaaziReason::Lead));
            }
        }

        let lead_after = self.baazi_lead;
        match baazi {
            Some((winner, reason)) => {
                self.baazis_won[winner as usize] += 1;
                self.baazi_lead = 0;
                self.baazi_winner = Some(winner);
                self.baazi_reason = Some(reason);
                self.phase = Phase::MatchComplete;
            }
            None => {
                self.baazi_winner = None;
                self.baazi_reason = None;
                self.phase = Phase::DealComplete;
            }
        }
        self.deal_history.push(DealResult {
            deal_no: self.deal_no,
            team_scores: tp,
            diff: tp[0] - tp[1],
            leftover_team: self.last_capture_team,
            baazi,
            lead_after,
            baazis_won_after: self.baazis_won,
        });
        self.revision += 1;
        self.tick();
        if baazi.is_some() {
            self.tick();
        }
    }

    /// The dealer stays while his team is not ahead; otherwise the deal
    /// passes to his right.
    fn next_deal(&mut self) {
        let lead = self.deal_history.last().map_or(0, |d| d.lead_after);
        let ahead = if lead == 0 { None } else { Some((lead < 0) as u8) };
        let next = if ahead == Some(team_of(self.dealer)) { right_of(self.dealer) } else { self.dealer };
        self.start_deal(next);
    }

    // ---------------------------------------------------------------
    // Comparison with the original TypeScript engine
    // ---------------------------------------------------------------

    /// The state in the shape the parity test compares against the TS engine.
    pub fn ts_snapshot(&self) -> Value {
        let cards = |v: &Vec<Card>| v.iter().map(|c| c.0).collect::<Vec<u8>>();
        let reason = |r: BaaziReason| match r {
            BaaziReason::Lead => "lead",
            BaaziReason::MinimumPoints => "minimum-points",
        };
        json!({
            "phase": match self.phase {
                Phase::Announce => "ANNOUNCE",
                Phase::TurnPlay => "TURN_PLAY",
                Phase::DealComplete => "DEAL_COMPLETE",
                Phase::MatchComplete => "MATCH_COMPLETE",
            },
            "hands": self.hands.iter().map(cards).collect::<Vec<_>>(),
            "tableLoose": cards(&self.loose),
            "houses": self.houses.iter().map(|h| json!({
                "id": format!("h-{}", h.id),
                "total": h.total,
                "owners": h.owners,
                "cards": cards(&h.cards),
            })).collect::<Vec<_>>(),
            "deck": cards(&self.deck),
            "bidderSeat": self.bidder,
            "dealerSeat": self.dealer,
            "dealNo": self.deal_no,
            "bid": self.bid,
            "dealRestPending": self.deal_rest_pending,
            "batchesDealt": self.batches_dealt,
            "playsMade": self.plays_made,
            "captures": self.captures.iter().map(cards).collect::<Vec<_>>(),
            "sweeps": self.sweeps,
            "sweepPoints": self.sweep_points,
            "lastCaptureTeam": self.last_capture_team,
            "lastPickup": self.last_pickup.as_ref().map(|p| json!({
                "seat": p.seat,
                "cards": cards(&p.cards),
                "playsMade": p.plays_made,
            })),
            "currentTurn": self.turn,
            "houseSeq": self.house_seq,
            "baaziLead": self.baazi_lead,
            "baazisWon": self.baazis_won,
            "dealHistory": self.deal_history.iter().map(|d| json!({
                "dealNo": d.deal_no,
                "teamScores": d.team_scores,
                "diff": d.diff,
                "leftoverTeam": d.leftover_team,
                "baazi": d.baazi.map(|(winner, r)| json!({ "winnerTeam": winner, "reason": reason(r) })),
                "leadAfter": d.lead_after,
                "baazisWonAfter": d.baazis_won_after,
            })).collect::<Vec<_>>(),
            "teamScores": self.team_scores,
            "roundWinnerTeam": self.round_winner,
            "baaziWinnerTeam": self.baazi_winner,
            "baaziReason": self.baazi_reason.map(reason),
            "tiedTeams": if self.team_scores.is_some() && self.round_winner.is_none() { vec![0, 1] } else { vec![] },
            "eventSeq": self.event_seq,
            "revision": self.revision,
        })
    }
}

impl SeepRules {
    /// The rules as the TypeScript engine's `rules` option.
    pub fn to_ts(&self) -> Value {
        serde_json::to_value(self).expect("rules serialise")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_takes_every_set_it_can() {
        // An 8 on A, 7, 3, 5, 8 takes all five cards, in one way.
        assert_eq!(capture_alternatives(&[1, 7, 3, 5, 8], 8), vec![vec![0b00011, 0b01100, 0b10000]]);
        // 2, 3, 2, 3 pair up into fives in two ways.
        assert_eq!(capture_alternatives(&[2, 3, 2, 3], 5).len(), 2);
        // A 9 on 4, 5, 5 takes the four with either five.
        assert_eq!(capture_alternatives(&[4, 5, 5], 9), vec![vec![0b011], vec![0b101]]);
        assert!(capture_alternatives(&[4, 6], 9).is_empty());
    }

    #[test]
    fn builds_must_split_into_whole_sets() {
        assert!(splits_into(&[9, 9], 9));
        assert!(splits_into(&[4, 5, 6, 3], 9));
        assert!(!splits_into(&[2, 8, 8], 9));
        assert!(!splits_into(&[10], 9));
    }

    /// Every play that could be written down for the seat to move, legal or not.
    fn every_play(g: &Seep) -> Vec<SeepAction> {
        use SeepAction::*;
        let mut all: Vec<SeepAction> = (0..16).map(|value| Announce { value }).collect();
        for card in 0..g.hands[g.turn as usize].len() as u8 {
            all.push(Lay { card });
            for loose in 0..1u32 << g.loose.len() {
                all.push(Capture { card, loose });
                for total in 0..16 {
                    all.push(Build { card, loose, total });
                    all.push(Add { card, total, loose });
                }
            }
            all.extend((0..16).map(|total| Break { card, total }));
        }
        all
    }

    #[test]
    fn legal_actions_are_all_that_apply_accepts() {
        let mut rng = Rng::new(5);
        let mut legal = Vec::new();
        let mut compared = 0;
        for _ in 0..40 {
            let rules = SeepRules { baazi_lead_target: 1, min_house_total: 5 + rng.int(5) as u8, ..SeepRules::default() };
            let mut g = Seep::deal(&rules, PLAYERS, rng.fork(), true).unwrap();
            while let Some(seat) = g.to_act() {
                g.legal_actions(&mut legal);
                if g.loose.len() <= 9 {
                    let accepted: Vec<SeepAction> =
                        every_play(&g).into_iter().filter(|a| g.clone().apply(seat, a).is_ok()).collect();
                    for a in &accepted {
                        assert!(legal.contains(a), "{a:?} is accepted but not listed\n{g:?}");
                    }
                    assert_eq!(accepted.len(), legal.len(), "{g:?}");
                    compared += 1;
                }
                let action = legal[rng.int(legal.len())];
                g.apply(seat, &action).unwrap();
            }
        }
        assert!(compared > 1000);
    }

    #[test]
    fn random_games_hold_the_invariants() {
        // Random play wanders towards the target slowly; keep matches short.
        let short = |rules: &mut Value, rng: &mut Rng| rules["baaziLeadTarget"] = json!(1 + rng.int(40));
        let report = crate::check::fuzz::<Seep>(300, 14, 4..=4, 100_000, short).unwrap_or_else(|e| panic!("{e}"));
        println!("{report:?}");
        assert_eq!(report.games, 300);
    }
}
