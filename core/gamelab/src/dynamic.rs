//! Every game behind one interface, chosen by name at run time.
//!
//! The bindings (Python for training, WebAssembly for the site) and the
//! command line work with `Box<dyn AnyGame>` and JSON rules, so a new game
//! only has to be added to `with_game!` below to reach all of them.

use crate::check::rules_from_json;
use crate::exact::{Enumerable, Tree};
use crate::game::{AtTable, Game, Seat, Stat};
use crate::games::{cabo::Cabo, minipoker::MiniPoker, pairone::PairOne, seep::Seep};
use crate::obs::Obs;
use crate::rng::Rng;
use crate::settings::{random_rules, Setting};
use serde::Serialize;
use serde_json::{json, Value};

/// Calls `$body` with `$G` bound to the game called `$id`.
macro_rules! with_game {
    ($id:expr, $G:ident => $body:expr, else $none:expr) => {
        match $id {
            <Cabo as Game>::ID => { type $G = Cabo; $body }
            <MiniPoker as Game>::ID => { type $G = MiniPoker; $body }
            <PairOne as Game>::ID => { type $G = PairOne; $body }
            <Seep as Game>::ID => { type $G = Seep; $body }
            _ => $none,
        }
    };
}

pub trait AnyGame: Send + Sync {
    fn id(&self) -> &'static str;
    fn number(&self) -> u16;
    fn rules(&self) -> Value;
    fn players(&self) -> usize;
    fn to_act(&self) -> Option<Seat>;
    fn is_over(&self) -> bool {
        self.to_act().is_none()
    }
    /// How many actions the seat to move may take.
    fn legal(&self) -> usize;
    fn legal_json(&self) -> Vec<Value>;
    /// Take the `index`-th legal action, counted as in `Obs::actions`.
    fn step(&mut self, index: usize) -> Result<(), String>;
    /// An action from outside (a person at the table), by any seat.
    fn apply_json(&mut self, seat: Seat, action: &Value) -> Result<(), String>;
    /// Why `apply_json` would refuse this, or `None` when it would accept it.
    fn check_json(&self, seat: Seat, action: &Value) -> Option<String>;
    /// The whole round as plain JSON, for `load`.
    fn save(&self) -> Value;
    fn returns(&self) -> Vec<f32>;
    /// The lab's measurements of a finished round, as `GameInfo::stats` names them.
    fn stats(&self) -> Vec<f32>;
    fn observe(&self, seat: Seat, omniscient: bool, obs: &mut Obs);
    fn determinize(&self, seat: Seat, rng: &mut Rng) -> Box<dyn AnyGame>;
    /// `Game::for_seat`.
    fn for_seat(&self, seat: Seat, reacting: bool, rng: &mut Rng) -> Option<Box<dyn AnyGame>>;
    /// `Game::at_table` for the `index`-th legal action: `{ "action": .., "more": .. }`,
    /// the action being null when nothing happens at the table.
    fn at_table(&self, index: usize) -> Result<Value, String>;
    fn boxed(&self) -> Box<dyn AnyGame>;
}

#[derive(Clone)]
struct Held<G: Game> {
    game: G,
    rules: G::Rules,
    legal: Vec<G::Action>,
}

impl<G: Game> Held<G> {
    fn hold(game: G, rules: G::Rules) -> Held<G> {
        let mut legal = Vec::new();
        game.legal_actions(&mut legal);
        Held { game, rules, legal }
    }
}

impl<G: Game> AnyGame for Held<G> {
    fn id(&self) -> &'static str {
        G::ID
    }
    fn number(&self) -> u16 {
        G::NUMBER
    }
    fn rules(&self) -> Value {
        serde_json::to_value(&self.rules).unwrap()
    }
    fn players(&self) -> usize {
        self.game.players()
    }
    fn to_act(&self) -> Option<Seat> {
        self.game.to_act()
    }
    fn legal(&self) -> usize {
        self.legal.len()
    }
    fn legal_json(&self) -> Vec<Value> {
        self.legal.iter().map(|a| serde_json::to_value(a).unwrap()).collect()
    }
    fn step(&mut self, index: usize) -> Result<(), String> {
        let seat = self.game.to_act().ok_or("the round is over")?;
        let action = self.legal.get(index).ok_or("no such action")?.clone();
        self.game.apply(seat, &action).map_err(|e| e.to_string())?;
        self.game.legal_actions(&mut self.legal);
        Ok(())
    }
    fn apply_json(&mut self, seat: Seat, action: &Value) -> Result<(), String> {
        let action: G::Action = serde_json::from_value(action.clone()).map_err(|e| e.to_string())?;
        self.game.apply(seat, &action).map_err(|e| e.to_string())?;
        self.game.legal_actions(&mut self.legal);
        Ok(())
    }
    fn check_json(&self, seat: Seat, action: &Value) -> Option<String> {
        match serde_json::from_value::<G::Action>(action.clone()) {
            Ok(action) => self.game.check(seat, &action).err().map(|e| e.to_string()),
            Err(e) => Some(e.to_string()),
        }
    }
    fn save(&self) -> Value {
        json!({ "rules": self.rules, "game": self.game })
    }
    fn returns(&self) -> Vec<f32> {
        self.game.returns()
    }
    fn stats(&self) -> Vec<f32> {
        self.game.stats()
    }
    fn observe(&self, seat: Seat, omniscient: bool, obs: &mut Obs) {
        self.game.observe(seat, omniscient, obs)
    }
    fn determinize(&self, seat: Seat, rng: &mut Rng) -> Box<dyn AnyGame> {
        Box::new(Held::hold(self.game.determinize(seat, rng), self.rules.clone()))
    }
    fn for_seat(&self, seat: Seat, reacting: bool, rng: &mut Rng) -> Option<Box<dyn AnyGame>> {
        let game = self.game.for_seat(seat, reacting, rng)?;
        Some(Box::new(Held::hold(game, self.rules.clone())))
    }
    fn at_table(&self, index: usize) -> Result<Value, String> {
        let seat = self.game.to_act().ok_or("the round is over")?;
        let action = self.legal.get(index).ok_or("no such action")?;
        Ok(match self.game.at_table(seat, action) {
            AtTable::Play(a) => json!({ "action": a, "more": false }),
            AtTable::Nothing => json!({ "action": null, "more": false }),
            AtTable::More => json!({ "action": null, "more": true }),
        })
    }
    fn boxed(&self) -> Box<dyn AnyGame> {
        Box::new(self.clone())
    }
}

/// What the lab needs to know about a game before starting one.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInfo {
    pub id: &'static str,
    pub number: u16,
    pub min_players: usize,
    pub max_players: usize,
    pub settings: Vec<Setting>,
    /// Named rule sets; the first is the default.
    pub presets: Vec<(&'static str, Value)>,
    /// Action verbs: number (as in an action row, without the game's block) and name.
    pub verbs: Vec<(u16, &'static str)>,
    /// What is measured about each finished round.
    pub stats: Vec<Stat>,
}

fn info_of<G: Game>() -> GameInfo {
    GameInfo {
        id: G::ID,
        number: G::NUMBER,
        min_players: G::PLAYERS.0,
        max_players: G::PLAYERS.1,
        settings: G::settings(),
        presets: G::presets().into_iter().map(|(name, r)| (name, serde_json::to_value(r).unwrap())).collect(),
        verbs: G::verbs(),
        stats: G::stat_names(),
    }
}

pub const GAME_IDS: [&str; 4] = [Cabo::ID, MiniPoker::ID, PairOne::ID, Seep::ID];

pub fn info(id: &str) -> Option<GameInfo> {
    with_game!(id, G => Some(info_of::<G>()), else None)
}

pub fn games() -> Vec<GameInfo> {
    GAME_IDS.iter().map(|id| info(id).unwrap()).collect()
}

/// Deal a round of the game called `id`. `rules` must give every setting.
pub fn create(id: &str, rules: &Value, players: usize, seed: u64) -> Result<Box<dyn AnyGame>, String> {
    fn make<G: Game>(rules: &Value, players: usize, seed: u64) -> Result<Box<dyn AnyGame>, String> {
        let rules = rules_from_json::<G>(rules)?;
        let game = G::new(&rules, players, Rng::from_u64(seed))?;
        Ok(Box::new(Held::hold(game, rules)))
    }
    with_game!(id, G => make::<G>(rules, players, seed), else Err(format!("unknown game {id}")))
}

/// Deal a round for people at a table (`Game::live`).
pub fn create_live(id: &str, rules: &Value, players: usize, rng: Rng) -> Result<Box<dyn AnyGame>, String> {
    fn make<G: Game>(rules: &Value, players: usize, rng: Rng) -> Result<Box<dyn AnyGame>, String> {
        let rules = rules_from_json::<G>(rules)?;
        let game = G::live(&rules, players, rng)?;
        Ok(Box::new(Held::hold(game, rules)))
    }
    with_game!(id, G => make::<G>(rules, players, rng), else Err(format!("unknown game {id}")))
}

/// A round written by `AnyGame::save`.
pub fn load(id: &str, saved: &Value) -> Result<Box<dyn AnyGame>, String> {
    fn make<G: Game>(saved: &Value) -> Result<Box<dyn AnyGame>, String> {
        let rules = rules_from_json::<G>(saved.get("rules").ok_or("no rules in the saved round")?)?;
        let game: G = serde_json::from_value(saved.get("game").cloned().ok_or("no game in the saved round")?)
            .map_err(|e| e.to_string())?;
        Ok(Box::new(Held::hold(game, rules)))
    }
    with_game!(id, G => make::<G>(saved), else Err(format!("unknown game {id}")))
}

/// The whole game written out, for the games small enough (see `exact`).
pub fn exact_tree(id: &str, rules: &Value, players: usize, node_limit: usize) -> Result<Tree, String> {
    match id {
        <MiniPoker as Game>::ID => {
            let rules = rules_from_json::<MiniPoker>(rules)?;
            Tree::build(MiniPoker::roots(&rules, players)?, node_limit)
        }
        _ => Err(format!("{id} cannot be written out in full")),
    }
}

/// Rules drawn at random around `base` (see `settings::random_rules`), tried
/// until the game accepts them for `players`.
pub fn sample_rules(id: &str, base: &Value, players: usize, rng: &mut Rng) -> Result<Value, String> {
    let info = info(id).ok_or_else(|| format!("unknown game {id}"))?;
    for _ in 0..200 {
        let rules = random_rules(&info.settings, base, rng);
        if create(id, &rules, players, 0).is_ok() {
            return Ok(rules);
        }
    }
    Err(format!("no playable rules found near the base rules of {id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_game_plays_through_the_common_interface() {
        let mut rng = Rng::new(5);
        let mut obs = Obs::default();
        for info in games() {
            assert!(info.number < 16 && !info.presets.is_empty());
            for round in 0..40 {
                let players = info.min_players + rng.int(info.max_players - info.min_players + 1);
                let (_, base) = &info.presets[round % info.presets.len()];
                let rules = if round % 2 == 0 { base.clone() } else { sample_rules(info.id, base, players, &mut rng).unwrap() };
                let Ok(mut g) = create(info.id, &rules, players, round as u64) else {
                    assert!(round % 2 == 0, "sampled rules must be playable");
                    continue; // a preset need not suit every player count
                };
                for _ in 0..3_000 {
                    let Some(seat) = g.to_act() else { break };
                    g.observe(seat, false, &mut obs);
                    assert_eq!(obs.actions.len(), g.legal());
                    let mut copy = g.determinize(seat, &mut rng);
                    copy.step(rng.int(copy.legal())).unwrap();
                    g.step(rng.int(g.legal())).unwrap();
                }
                if g.is_over() {
                    assert_eq!(g.stats().len(), info.stats.len());
                    assert!(info.stats.len() <= crate::vecenv::MAX_STATS);
                    assert!(g.returns().iter().sum::<f32>().abs() < 1e-4);
                }
            }
        }
    }
}
