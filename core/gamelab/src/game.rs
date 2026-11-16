//! The interface every game in the core implements.
//!
//! A game value is the complete, authoritative state of one round, including
//! its rules and its random generators, so cloning it gives an independent
//! copy to search or simulate from.
//!
//! Games are sequential for simulation: `to_act` names the one seat that
//! decides next and `legal_actions` lists its options. Games where seats may
//! act at the same time on the live site (Cabo's flush race) keep that freedom
//! in live mode and order those moments explicitly in simulation mode.

use crate::obs::Obs;
use crate::rng::Rng;
use crate::settings::Setting;
use serde::{de::DeserializeOwned, Serialize};
use std::fmt::Debug;

pub type Seat = u8;

/// Why an action was refused. The state is unchanged when this is returned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Illegal(pub &'static str);

impl std::fmt::Display for Illegal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

/// A number the lab reports about finished rounds.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Stat {
    pub key: &'static str,
    pub label: &'static str,
}

impl Stat {
    pub const fn new(key: &'static str, label: &'static str) -> Stat {
        Stat { key, label }
    }
}

pub trait Game: Clone + Sized + Send + Sync + Serialize + DeserializeOwned + 'static {
    /// Stable identifier, e.g. `"cabo"`.
    const ID: &'static str;
    /// Stable number below 16, used in observation codes (`obs::game_code`).
    const NUMBER: u16;
    /// Fewest and most players.
    const PLAYERS: (usize, usize);

    type Rules: Clone + Default + Debug + Serialize + DeserializeOwned + Send + Sync;
    type Action: Clone + PartialEq + Debug + Serialize + DeserializeOwned + Send + Sync;

    /// Deal a new round. Fails when the rules or the player count are invalid.
    fn new(rules: &Self::Rules, players: usize, rng: Rng) -> Result<Self, String>;

    /// Deal a round for people at a table rather than for simulation. Games
    /// where the two differ (see the module docs) say how in their own docs.
    fn live(rules: &Self::Rules, players: usize, rng: Rng) -> Result<Self, String> {
        Self::new(rules, players, rng)
    }

    fn players(&self) -> usize;

    fn is_over(&self) -> bool;

    /// The seat that decides next, or `None` when the round is over.
    fn to_act(&self) -> Option<Seat>;

    /// Every action `to_act()` may take, appended to `out` (cleared first).
    fn legal_actions(&self, out: &mut Vec<Self::Action>);

    fn apply(&mut self, seat: Seat, action: &Self::Action) -> Result<(), Illegal>;

    /// Whether `apply` would accept this, without changing anything.
    fn check(&self, seat: Seat, action: &Self::Action) -> Result<(), Illegal> {
        self.clone().apply(seat, action)
    }

    /// Final utility per seat, zero-sum: +1 for a sole winner in games that
    /// are simply won or lost, chips won in betting games. Only meaningful
    /// once `is_over()`.
    fn returns(&self) -> Vec<f32>;

    /// How the lab presents each field of `Rules` for editing.
    fn settings() -> Vec<Setting>;

    /// Named rule sets the lab offers as starting points; the first is the default.
    fn presets() -> Vec<(&'static str, Self::Rules)> {
        vec![("Standard", Self::Rules::default())]
    }

    /// Names of the action verbs, numbered as in `ActionToken::verb` without
    /// the game's block, for the lab's count of how often each is used.
    fn verbs() -> Vec<(u16, &'static str)>;

    /// What the lab measures about a finished round, beyond who won.
    fn stat_names() -> Vec<Stat> {
        Vec::new()
    }

    /// The measurements of this finished round, in the order of
    /// `stat_names`; NaN where one does not apply (who won a call nobody made).
    fn stats(&self) -> Vec<f32> {
        Vec::new()
    }

    /// What `seat` sees, written into `obs` (cleared first). With `omniscient`
    /// every hidden card is shown as well; training uses that for the value
    /// estimate only, never for choosing moves.
    fn observe(&self, seat: Seat, omniscient: bool, obs: &mut Obs);

    /// A state `seat` cannot tell apart from this one: everything hidden from
    /// `seat` is dealt again at random, and the future is re-seeded from `rng`.
    /// `observe(seat, false, ..)` gives the same result on both.
    fn determinize(&self, seat: Seat, rng: &mut Rng) -> Self;

    /// This round, dealt for people at a table (`live`), in the form `new`
    /// deals and at a decision of `seat`, so that the model can be asked for
    /// its move; `None` when `seat` has nothing to decide. `reacting` asks
    /// about the moves a table allows out of turn (Cabo's flush) instead of
    /// the seat's own turn.
    fn for_seat(&self, seat: Seat, reacting: bool, _rng: &mut Rng) -> Option<Self> {
        (!reacting && self.to_act() == Some(seat)).then(|| self.clone())
    }

    /// The move of the game's hand-written player for the seat to act, for
    /// the games that have one. It is an opponent to train against and a bar
    /// to beat; it sees only what its seat sees.
    fn scripted(&self, _rng: &mut Rng) -> Option<Self::Action> {
        None
    }

    /// What `action`, chosen by `seat` in a round `for_seat` returned (`self`,
    /// before the action is applied to it), means at the table.
    fn at_table(&self, _seat: Seat, action: &Self::Action) -> AtTable<Self::Action> {
        AtTable::Play(action.clone())
    }
}

/// See `Game::at_table`.
#[derive(Clone, Debug, PartialEq)]
pub enum AtTable<A> {
    /// Take this action at the table.
    Play(A),
    /// Nothing happens at the table (the seat declined to react).
    Nothing,
    /// Apply the action to the round `for_seat` returned and choose again:
    /// the table takes several of these choices as one action.
    More,
}

/// Zero-sum utilities from a list of winners: a sole winner gets +1 and each
/// loser `-1 / (n - 1)`; tied winners share the pot.
pub fn winner_returns(players: usize, winners: &[Seat]) -> Vec<f32> {
    let n = players as f32;
    let share = if winners.is_empty() { 1.0 / n } else { 1.0 / winners.len() as f32 };
    (0..players)
        .map(|p| {
            let w = if winners.is_empty() || winners.contains(&(p as Seat)) { share } else { 0.0 };
            (w - 1.0 / n) * n / (n - 1.0)
        })
        .collect()
}
