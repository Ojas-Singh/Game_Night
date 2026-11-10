//! Many tables played at once, for self-play and evaluation.
//!
//! Each table deals a round from one of the `TableSpec`s, and deals again as
//! soon as the round ends. `observe` gives what the seat to move sees at
//! every table as flat arrays padded to a common size, `step` takes one
//! action per table. Every table has its own random generator, so a run is
//! the same whatever the number of threads.
//!
//! Each seat of a round is given a *controller*: 0 is the player being
//! trained, other numbers are whatever the caller means by them (earlier
//! versions of the player, fixed opponents). The caller reads `control` in
//! the batch and asks the right player for each table's action.

use crate::dynamic::{create, info, sample_rules, AnyGame};
use crate::obs::{ActionToken, Obs, Token, FIELDS};
use crate::rng::Rng;
use rayon::prelude::*;
use serde::Deserialize;
use serde_json::Value;

pub const MAX_SEATS: usize = 8;
/// Most measurements a game reports about a finished round.
pub const MAX_STATS: usize = 12;
/// Numbers per action: verb, three arguments, parameter.
pub const ACTION_FIELDS: usize = 5;

/// One kind of table in the mix.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSpec {
    pub game: String,
    /// The rules, or the centre of the random rules; the game's default when absent.
    #[serde(default)]
    pub rules: Option<Value>,
    /// Fewest and most players; the game's own limits when absent.
    #[serde(default)]
    pub players: Option<(usize, usize)>,
    /// Share of rounds played with rules drawn at random around `rules`.
    #[serde(default)]
    pub randomize: f32,
    /// How often this kind of table is dealt, relative to the others.
    #[serde(default = "one")]
    pub weight: f32,
}

fn one() -> f32 {
    1.0
}

struct Kind {
    game: String,
    rules: Value,
    players: (usize, usize),
    randomize: f32,
    weight: f32,
}

/// A round that has just ended.
#[derive(Clone, Debug)]
pub struct Finished {
    pub env: u32,
    pub spec: u16,
    pub players: u8,
    pub steps: u32,
    /// Stopped at the step limit; the returns are all zero.
    pub truncated: bool,
    pub control: [u8; MAX_SEATS],
    pub returns: [f32; MAX_SEATS],
    /// The game's measurements of the round (`GameInfo::stats`), NaN beyond
    /// them and where one does not apply.
    pub stats: [f32; MAX_STATS],
}

struct Table {
    game: Box<dyn AnyGame>,
    spec: u16,
    steps: u32,
    control: [u8; MAX_SEATS],
    rng: Rng,
    obs: Obs,
}

/// What the seat to move sees at every table. Row `i` of each array belongs
/// to table `i`; token and action rows are padded with zeros.
#[derive(Default)]
pub struct Batch {
    pub n: usize,
    pub max_tokens: usize,
    pub max_actions: usize,
    /// `n * max_tokens * FIELDS`.
    pub tokens: Vec<u16>,
    pub token_count: Vec<u16>,
    /// `n * max_actions * ACTION_FIELDS`; an unused argument is `NO_ARG`.
    pub actions: Vec<u16>,
    pub action_count: Vec<u16>,
    pub seat: Vec<u8>,
    pub players: Vec<u8>,
    pub control: Vec<u8>,
    pub game: Vec<u8>,
    pub spec: Vec<u16>,
}

impl Batch {
    /// Lay the observations out as rows padded to a common size. The columns
    /// that describe the tables are left to the caller.
    pub fn pack(&mut self, obs: &[&Obs]) {
        let n = obs.len();
        let max_tokens = obs.iter().map(|o| o.tokens.len()).max().unwrap_or(0);
        let max_actions = obs.iter().map(|o| o.actions.len()).max().unwrap_or(0);
        self.n = n;
        self.max_tokens = max_tokens;
        self.max_actions = max_actions;
        self.tokens.clear();
        self.tokens.resize(n * max_tokens * FIELDS, 0);
        self.actions.clear();
        self.actions.resize(n * max_actions * ACTION_FIELDS, 0);
        let rows = self
            .tokens
            .par_chunks_mut((max_tokens * FIELDS).max(1))
            .zip(self.actions.par_chunks_mut((max_actions * ACTION_FIELDS).max(1)))
            .with_min_len(64);
        obs.par_iter().zip(rows).for_each(|(o, (tokens, actions))| {
            for (dst, Token(src)) in tokens.chunks_exact_mut(FIELDS).zip(&o.tokens) {
                dst.copy_from_slice(src);
            }
            for (dst, a) in actions.chunks_exact_mut(ACTION_FIELDS).zip(&o.actions) {
                let ActionToken { verb, args, param } = *a;
                dst.copy_from_slice(&[verb, args[0], args[1], args[2], param]);
            }
        });
        self.token_count.clear();
        self.token_count.extend(obs.iter().map(|o| o.tokens.len() as u16));
        self.action_count.clear();
        self.action_count.extend(obs.iter().map(|o| o.actions.len() as u16));
    }
}

pub struct VecEnv {
    kinds: Vec<Kind>,
    league: Vec<f32>,
    tables: Vec<Table>,
    step_limit: u32,
}

fn pick(weights: impl Iterator<Item = f32> + Clone, rng: &mut Rng) -> usize {
    let total: f32 = weights.clone().sum();
    let mut x = rng.next_f32() * total;
    let mut last = 0;
    for (i, w) in weights.enumerate() {
        if w > 0.0 {
            last = i;
            if x < w {
                return i;
            }
            x -= w;
        }
    }
    last
}

fn deal(kinds: &[Kind], league: &[f32], rng: &mut Rng) -> (Box<dyn AnyGame>, u16, [u8; MAX_SEATS]) {
    let spec = pick(kinds.iter().map(|k| k.weight), rng);
    let k = &kinds[spec];
    let players = k.players.0 + rng.int(k.players.1 - k.players.0 + 1);
    let sampled = (rng.next_f32() < k.randomize).then(|| sample_rules(&k.game, &k.rules, players, rng).ok()).flatten();
    let seed = (rng.next_u32() as u64) << 32 | rng.next_u32() as u64;
    let game = create(&k.game, sampled.as_ref().unwrap_or(&k.rules), players, seed)
        .expect("the rules were checked when the tables were set up");
    // One seat chosen at random is the player being trained; the others are
    // drawn from the league.
    let mut control = [0u8; MAX_SEATS];
    let learner = rng.int(players);
    for (seat, c) in control.iter_mut().enumerate().take(players) {
        if seat != learner {
            *c = pick(league.iter().copied(), rng) as u8;
        }
    }
    (game, spec as u16, control)
}

impl VecEnv {
    /// `league[c]` is how often a seat other than the trained one is given
    /// controller `c`; `[1.0]` is plain self-play.
    pub fn new(specs: &[TableSpec], tables: usize, seed: u64, step_limit: u32, league: &[f32]) -> Result<VecEnv, String> {
        if specs.is_empty() || tables == 0 {
            return Err("at least one kind of table and one table are needed".into());
        }
        let mut kinds = Vec::new();
        for s in specs {
            let info = info(&s.game).ok_or_else(|| format!("unknown game {}", s.game))?;
            let players = s.players.unwrap_or((info.min_players, info.max_players));
            if players.0 < info.min_players || players.1 > info.max_players || players.0 > players.1 {
                return Err(format!("{} is for {} to {} players", s.game, info.min_players, info.max_players));
            }
            let rules = s.rules.clone().unwrap_or_else(|| info.presets[0].1.clone());
            for n in players.0..=players.1 {
                create(&s.game, &rules, n, 0).map_err(|e| format!("{} with {n} players: {e}", s.game))?;
            }
            if !(s.weight > 0.0) || !(0.0..=1.0).contains(&s.randomize) {
                return Err("a table's weight must be positive and its random share between 0 and 1".into());
            }
            kinds.push(Kind { game: s.game.clone(), rules, players, randomize: s.randomize, weight: s.weight });
        }
        let mut env = VecEnv { kinds, league: Vec::new(), tables: Vec::new(), step_limit };
        env.set_league(league)?;
        let mut master = Rng::from_u64(seed);
        for _ in 0..tables {
            let mut rng = master.fork();
            let (game, spec, control) = deal(&env.kinds, &env.league, &mut rng);
            env.tables.push(Table { game, spec, steps: 0, control, rng, obs: Obs::default() });
        }
        Ok(env)
    }

    /// Change the mix of opponents for rounds dealt from now on.
    pub fn set_league(&mut self, league: &[f32]) -> Result<(), String> {
        if league.is_empty() || league.len() > 255 || league.iter().any(|w| !(*w >= 0.0)) || league.iter().sum::<f32>() <= 0.0 {
            return Err("the league needs between 1 and 255 weights, none negative, not all zero".into());
        }
        self.league = league.to_vec();
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.tables.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tables.is_empty()
    }

    /// The round in play at a table.
    pub fn game(&self, env: usize) -> &dyn AnyGame {
        &*self.tables[env].game
    }

    /// The rules in force at a table, for reports.
    pub fn rules(&self, env: usize) -> Value {
        self.tables[env].game.rules()
    }

    /// What the seat to move sees at every table. With `omniscient` the
    /// hidden cards are shown too (for the value estimate in training).
    pub fn observe(&mut self, omniscient: bool, out: &mut Batch) {
        self.tables.par_iter_mut().with_min_len(64).for_each(|t| {
            let seat = t.game.to_act().expect("a finished round is dealt again at once");
            t.game.observe(seat, omniscient, &mut t.obs);
        });
        out.pack(&self.tables.iter().map(|t| &t.obs).collect::<Vec<_>>());
        macro_rules! column {
            ($field:ident, $f:expr) => {
                out.$field.clear();
                out.$field.extend(self.tables.iter().map($f));
            };
        }
        column!(seat, |t| t.game.to_act().unwrap());
        column!(players, |t| t.game.players() as u8);
        column!(control, |t| t.control[t.game.to_act().unwrap() as usize]);
        column!(game, |t| t.game.number() as u8);
        column!(spec, |t| t.spec);
    }

    /// Take `actions[i]` (an index into the table's legal actions) at table
    /// `i`. Rounds that end are reported and dealt again.
    pub fn step(&mut self, actions: &[u32]) -> Result<Vec<Finished>, String> {
        if actions.len() != self.tables.len() {
            return Err(format!("{} actions for {} tables", actions.len(), self.tables.len()));
        }
        let (kinds, league, limit) = (&self.kinds, &self.league, self.step_limit);
        let done: Vec<Result<Option<Finished>, String>> = self
            .tables
            .par_iter_mut()
            .zip(actions)
            .enumerate()
            .with_min_len(64)
            .map(|(env, (t, &a))| {
                t.game.step(a as usize).map_err(|e| format!("table {env}: action {a}: {e}"))?;
                t.steps += 1;
                let over = t.game.is_over();
                if !over && t.steps < limit {
                    return Ok(None);
                }
                let players = t.game.players();
                let mut returns = [0.0; MAX_SEATS];
                if over {
                    returns[..players].copy_from_slice(&t.game.returns());
                }
                let mut stats = [f32::NAN; MAX_STATS];
                if over {
                    let s = t.game.stats();
                    stats[..s.len()].copy_from_slice(&s);
                }
                let finished = Finished {
                    env: env as u32,
                    spec: t.spec,
                    players: players as u8,
                    steps: t.steps,
                    truncated: !over,
                    control: t.control,
                    returns,
                    stats,
                };
                (t.game, t.spec, t.control) = deal(kinds, league, &mut t.rng);
                t.steps = 0;
                Ok(Some(finished))
            })
            .collect();
        let mut finished = Vec::new();
        for d in done {
            finished.extend(d?);
        }
        Ok(finished)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn play(seed: u64, threads: usize) -> (u64, Vec<f32>) {
        let specs: Vec<TableSpec> = serde_json::from_value(json!([
            { "game": "cabo", "randomize": 0.5, "rules": null },
            { "game": "minipoker", "players": [2, 3], "weight": 2.0 },
            { "game": "pairone", "randomize": 1.0 },
        ]))
        .unwrap();
        let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
        pool.install(|| {
            let mut env = VecEnv::new(&specs, 300, seed, 400, &[1.0, 1.0, 2.0]).unwrap();
            let (mut batch, mut rng) = (Batch::default(), Rng::new(7));
            let (mut rounds, mut sums) = (0, vec![0.0; MAX_SEATS]);
            for step in 0..300 {
                env.observe(step % 2 == 0, &mut batch);
                assert!(batch.action_count.iter().all(|&a| a > 0));
                assert!(batch.control.iter().all(|&c| c < 3));
                let actions: Vec<u32> = batch.action_count.iter().map(|&a| rng.int(a as usize) as u32).collect();
                for f in env.step(&actions).unwrap() {
                    assert!(f.returns.iter().sum::<f32>().abs() < 1e-4);
                    assert_eq!(f.control[..f.players as usize].iter().filter(|c| **c == 0).count() >= 1, true);
                    rounds += 1;
                    sums.iter_mut().zip(f.returns).for_each(|(s, r)| *s += r);
                }
            }
            (rounds, sums)
        })
    }

    #[test]
    fn tables_play_the_same_on_any_number_of_threads() {
        let one = play(3, 1);
        assert!(one.0 > 1_000, "only {} rounds", one.0);
        assert_eq!(one, play(3, 4));
        assert_ne!(one, play(4, 4));
    }
}
