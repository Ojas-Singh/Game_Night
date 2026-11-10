//! The rules core for JavaScript: the site's server and the lab in the browser.
//!
//! Everything crosses the boundary as JSON text or flat number arrays, so the
//! JavaScript side needs no generated types beyond `Round`.

use gamelab::dynamic::{self, AnyGame};
use gamelab::obs::{Obs, FIELDS};
use gamelab::search::Search;
use gamelab::vecenv::{Batch, ACTION_FIELDS, MAX_SEATS};
use gamelab::Rng;
use serde_json::Value;
use wasm_bindgen::prelude::*;

fn err(e: impl ToString) -> JsError {
    JsError::new(&e.to_string())
}

fn parse(text: &str) -> Result<Value, JsError> {
    serde_json::from_str(text).map_err(err)
}

/// Every game: id, player limits, settings, presets, verbs and statistics.
#[wasm_bindgen]
pub fn games() -> String {
    serde_json::to_string(&dynamic::games()).unwrap()
}

/// Numbers per token and per action row in `Round::observe`, values per
/// position, and the size of a game's block of verb numbers (a row's verb,
/// modulo it, is the verb as `games` lists it).
#[wasm_bindgen]
pub fn layout() -> Vec<u32> {
    vec![FIELDS as u32, ACTION_FIELDS as u32, MAX_SEATS as u32, gamelab::obs::GAME_BLOCK as u32]
}

/// One round of one game.
#[wasm_bindgen]
pub struct Round {
    game: Box<dyn AnyGame>,
}

#[wasm_bindgen]
impl Round {
    /// Deal a round. `rules` is JSON giving every setting. `live` deals for
    /// people at a table, otherwise for simulation. The seed is 64 bits in two
    /// halves; `compat` selects the generator of the site's original engines
    /// (it uses `seed_lo` only), kept to check this core against them.
    #[wasm_bindgen(constructor)]
    pub fn new(game: &str, rules: &str, players: usize, seed_hi: u32, seed_lo: u32, live: bool, compat: bool) -> Result<Round, JsError> {
        let rules = parse(rules)?;
        let rng = if compat { Rng::ts_compat(seed_lo) } else { Rng::from_u64((seed_hi as u64) << 32 | seed_lo as u64) };
        let game = if live {
            dynamic::create_live(game, &rules, players, rng)
        } else {
            dynamic::create(game, &rules, players, (seed_hi as u64) << 32 | seed_lo as u64)
        };
        Ok(Round { game: game.map_err(err)? })
    }

    /// A round written by `save`.
    pub fn load(game: &str, saved: &str) -> Result<Round, JsError> {
        Ok(Round { game: dynamic::load(game, &parse(saved)?).map_err(err)? })
    }

    /// The whole round as JSON: `{ rules, game }`.
    pub fn save(&self) -> String {
        self.game.save().to_string()
    }

    pub fn copy(&self) -> Round {
        Round { game: self.game.boxed() }
    }

    #[wasm_bindgen(getter)]
    pub fn id(&self) -> String {
        self.game.id().to_string()
    }

    #[wasm_bindgen(getter)]
    pub fn players(&self) -> usize {
        self.game.players()
    }

    /// The seat that decides next, or -1 when the round is over.
    #[wasm_bindgen(getter, js_name = toAct)]
    pub fn to_act(&self) -> i32 {
        self.game.to_act().map_or(-1, |s| s as i32)
    }

    /// An action by any seat, as JSON. Returns why it was refused, if it was;
    /// the round is unchanged then.
    pub fn apply(&mut self, seat: u8, action: &str) -> Option<String> {
        match serde_json::from_str(action) {
            Ok(action) => self.game.apply_json(seat, &action).err(),
            Err(e) => Some(e.to_string()),
        }
    }

    /// Why `apply` would refuse this action, without changing anything.
    pub fn check(&self, seat: u8, action: &str) -> Option<String> {
        match serde_json::from_str(action) {
            Ok(action) => self.game.check_json(seat, &action),
            Err(e) => Some(e.to_string()),
        }
    }

    /// The actions open to the seat to move, as a JSON list.
    pub fn legal(&self) -> String {
        Value::Array(self.game.legal_json()).to_string()
    }

    /// Take the `index`-th action of `legal`.
    pub fn step(&mut self, index: usize) -> Result<(), JsError> {
        self.game.step(index).map_err(err)
    }

    pub fn returns(&self) -> Vec<f32> {
        self.game.returns()
    }

    pub fn stats(&self) -> Vec<f32> {
        self.game.stats()
    }

    /// What `seat` sees, for the model: the number of tokens, then every
    /// token (`layout()[0]` numbers each), then every legal action row
    /// (verb, three arguments, parameter).
    pub fn observe(&self, seat: u8, omniscient: bool) -> Result<Vec<u16>, JsError> {
        if seat as usize >= self.game.players() {
            return Err(err("no such seat"));
        }
        let mut obs = Obs::default();
        self.game.observe(seat, omniscient, &mut obs);
        let mut out = Vec::with_capacity(1 + obs.tokens.len() * FIELDS + obs.actions.len() * ACTION_FIELDS);
        out.push(obs.tokens.len() as u16);
        for t in &obs.tokens {
            out.extend_from_slice(&t.0);
        }
        for a in &obs.actions {
            out.push(a.verb);
            out.extend_from_slice(&a.args);
            out.push(a.param);
        }
        Ok(out)
    }

    /// A round `seat` cannot tell from this one, with the hidden cards dealt again.
    pub fn determinize(&self, seat: u8, seed: u32) -> Result<Round, JsError> {
        if seat as usize >= self.game.players() {
            return Err(err("no such seat"));
        }
        Ok(Round { game: self.game.determinize(seat, &mut Rng::new(seed)) })
    }

    /// This table round at a decision of `seat`, in the form the model plays
    /// (`reacting`: a move out of turn, such as a flush); nothing when the
    /// seat has no decision to make. Choose among `legal()` of the result.
    #[wasm_bindgen(js_name = forSeat)]
    pub fn for_seat(&self, seat: u8, reacting: bool, seed: u32) -> Option<Round> {
        if seat as usize >= self.game.players() {
            return None;
        }
        Some(Round { game: self.game.for_seat(seat, reacting, &mut Rng::new(seed))? })
    }

    /// What the `index`-th action of `legal` means at the table, as JSON
    /// `{ action, more }`: the action to apply to the table round (null for
    /// none); with `more`, `step(index)` here and choose again first.
    #[wasm_bindgen(js_name = atTable)]
    pub fn at_table(&self, index: usize) -> Result<String, JsError> {
        self.game.at_table(index).map(|v| v.to_string()).map_err(err)
    }
}

/// Looking ahead from a round for the seat to move (see `gamelab::search`):
/// every legal action is tried in several deals of the cards that seat cannot
/// see. `observe` lays the resulting positions out as rows for a network,
/// `step` plays them on, `finish` turns the judged rows into one value per action.
#[wasm_bindgen]
pub struct Lookahead {
    search: Search,
    batch: Batch,
}

#[wasm_bindgen]
impl Lookahead {
    #[wasm_bindgen(constructor)]
    pub fn new(round: &Round, samples: usize, seed: u32) -> Result<Lookahead, JsError> {
        let search = Search::new(&[round.game.as_ref()], samples, seed as u64).map_err(err)?;
        Ok(Lookahead { search, batch: Batch::default() })
    }

    /// Positions still in play: the rows of `observe`, `step` and `finish`.
    #[wasm_bindgen(getter)]
    pub fn rows(&self) -> usize {
        self.search.live()
    }

    /// Lay out what the seat to move sees at every row (`omniscient`: with
    /// every hidden card shown, for the judge). Read it with the getters below.
    pub fn observe(&mut self, omniscient: bool) {
        self.search.observe(omniscient, &mut self.batch);
    }

    #[wasm_bindgen(getter, js_name = maxTokens)]
    pub fn max_tokens(&self) -> usize {
        self.batch.max_tokens
    }

    #[wasm_bindgen(getter, js_name = maxActions)]
    pub fn max_actions(&self) -> usize {
        self.batch.max_actions
    }

    /// `rows * maxTokens * layout()[0]` numbers, padded with zeros.
    pub fn tokens(&self) -> Vec<u16> {
        self.batch.tokens.clone()
    }

    #[wasm_bindgen(js_name = tokenCount)]
    pub fn token_count(&self) -> Vec<u16> {
        self.batch.token_count.clone()
    }

    /// `rows * maxActions * layout()[1]` numbers, padded with zeros.
    pub fn actions(&self) -> Vec<u16> {
        self.batch.actions.clone()
    }

    #[wasm_bindgen(js_name = actionCount)]
    pub fn action_count(&self) -> Vec<u16> {
        self.batch.action_count.clone()
    }

    /// Play the chosen legal action at every row.
    pub fn step(&mut self, actions: &[u32]) -> Result<(), JsError> {
        self.search.step(actions).map_err(err)
    }

    /// The value of each action of the round to its seat to move, from
    /// `layout()[2]` values per row (counted from the seat to move there).
    /// A finished position counts with its result divided by `scale`.
    pub fn finish(&self, values: &[f32], scale: f32) -> Result<Vec<f32>, JsError> {
        Ok(self.search.finish(values, &[scale; 16]).map_err(err)?.q)
    }
}
