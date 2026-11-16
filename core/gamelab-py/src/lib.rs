//! Python bindings. Arrays cross the boundary as bytes; `gamelab/__init__.py`
//! turns them into NumPy arrays of the right shape.

use gamelab::dynamic::{self, AnyGame};
use gamelab::exact::{Strategy, Tree};
use gamelab::search;
use gamelab::obs::{Obs, FIELDS, FIELD_SIZE, GAME_BLOCK, NO_ARG};
use gamelab::vecenv::{Batch, TableSpec, VecEnv, ACTION_FIELDS, MAX_SEATS, MAX_STATS};
use gamelab::Rng;
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict};

fn err(e: impl ToString) -> PyErr {
    PyValueError::new_err(e.to_string())
}

fn bytes<'py, T: Copy>(py: Python<'py>, data: &[T]) -> Bound<'py, PyBytes> {
    // Plain numbers only (u8, u16, u32, f32, f64): any bit pattern is valid bytes.
    let raw = unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, std::mem::size_of_val(data)) };
    PyBytes::new(py, raw)
}

fn obs_dict<'py>(py: Python<'py>, obs: &Obs) -> PyResult<Bound<'py, PyDict>> {
    let tokens: Vec<u16> = obs.tokens.iter().flat_map(|t| t.0).collect();
    let actions: Vec<u16> = obs.actions.iter().flat_map(|a| [a.verb, a.args[0], a.args[1], a.args[2], a.param]).collect();
    let d = PyDict::new(py);
    d.set_item("tokens", bytes(py, &tokens))?;
    d.set_item("actions", bytes(py, &actions))?;
    Ok(d)
}

fn batch_dict<'py>(py: Python<'py>, b: &Batch) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("n", b.n)?;
    d.set_item("max_tokens", b.max_tokens)?;
    d.set_item("max_actions", b.max_actions)?;
    d.set_item("tokens", bytes(py, &b.tokens))?;
    d.set_item("token_count", bytes(py, &b.token_count))?;
    d.set_item("actions", bytes(py, &b.actions))?;
    d.set_item("action_count", bytes(py, &b.action_count))?;
    d.set_item("seat", bytes(py, &b.seat))?;
    d.set_item("players", bytes(py, &b.players))?;
    d.set_item("control", bytes(py, &b.control))?;
    d.set_item("game", bytes(py, &b.game))?;
    d.set_item("spec", bytes(py, &b.spec))?;
    Ok(d)
}

fn u32s(data: &[u8]) -> PyResult<Vec<u32>> {
    if data.len() % 4 != 0 {
        return Err(err("whole u32 numbers are needed"));
    }
    Ok(data.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect())
}

/// A look ahead from one or more positions (see `gamelab::search`).
#[pyclass]
struct Search {
    inner: search::Search,
    batch: Batch,
}

impl Search {
    fn start(py: Python<'_>, roots: &[&dyn AnyGame], samples: usize, seed: u64) -> PyResult<Search> {
        let inner = py.detach(|| search::Search::new(roots, samples, seed)).map_err(err)?;
        Ok(Search { inner, batch: Batch::default() })
    }
}

#[pymethods]
impl Search {
    /// From the positions of single rounds.
    #[staticmethod]
    fn of_rounds(py: Python<'_>, rounds: Vec<PyRef<Round>>, samples: usize, seed: u64) -> PyResult<Search> {
        let roots: Vec<&dyn AnyGame> = rounds.iter().map(|r| &*r.game).collect();
        Search::start(py, &roots, samples, seed)
    }

    /// Leaves still in play.
    fn __len__(&self) -> usize {
        self.inner.live()
    }

    fn observe<'py>(&mut self, py: Python<'py>, omniscient: bool) -> PyResult<Bound<'py, PyDict>> {
        let (inner, batch) = (&mut self.inner, &mut self.batch);
        py.detach(|| inner.observe(omniscient, batch));
        batch_dict(py, &self.batch)
    }

    /// `actions` is one little-endian u32 per leaf still in play.
    fn step(&mut self, py: Python<'_>, actions: &[u8]) -> PyResult<()> {
        let actions = u32s(actions)?;
        let inner = &mut self.inner;
        py.detach(|| inner.step(&actions)).map_err(err)
    }

    /// `values` is f32 [leaves still in play, MAX_SEATS]. Returns (f32 values
    /// [roots, widest], widest, deals used for each root as u32).
    fn finish<'py>(&self, py: Python<'py>, values: &[u8], scale: Vec<f32>) -> PyResult<(Bound<'py, PyBytes>, usize, Bound<'py, PyBytes>)> {
        if values.len() % 4 != 0 {
            return Err(err("whole f32 numbers are needed"));
        }
        let values: Vec<f32> = values.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
        let out = self.inner.finish(&values, &scale).map_err(err)?;
        Ok((bytes(py, &out.q), out.max_actions, bytes(py, &out.samples)))
    }
}

/// Many tables played at once (see `gamelab::vecenv`).
#[pyclass]
struct Tables {
    env: VecEnv,
    batch: Batch,
}

#[pymethods]
impl Tables {
    #[new]
    #[pyo3(signature = (specs, tables, seed=0, step_limit=2000, league=vec![1.0], scripted=None))]
    fn new(specs: &str, tables: usize, seed: u64, step_limit: u32, league: Vec<f32>, scripted: Option<u8>) -> PyResult<Tables> {
        let specs: Vec<TableSpec> = serde_json::from_str(specs).map_err(err)?;
        let env = VecEnv::new(&specs, tables, seed, step_limit, &league, scripted).map_err(err)?;
        Ok(Tables { env, batch: Batch::default() })
    }

    fn __len__(&self) -> usize {
        self.env.len()
    }

    fn set_league(&mut self, league: Vec<f32>) -> PyResult<()> {
        self.env.set_league(&league).map_err(err)
    }

    /// The rules in force at a table, as JSON.
    fn rules(&self, env: usize) -> PyResult<String> {
        if env >= self.env.len() {
            return Err(err("no such table"));
        }
        Ok(self.env.rules(env).to_string())
    }

    fn observe<'py>(&mut self, py: Python<'py>, omniscient: bool) -> PyResult<Bound<'py, PyDict>> {
        let (env, batch) = (&mut self.env, &mut self.batch);
        py.detach(|| env.observe(omniscient, batch));
        batch_dict(py, &self.batch)
    }

    /// A look ahead from the tables listed in `rows` (little-endian u32).
    fn search(&self, py: Python<'_>, rows: &[u8], samples: usize, seed: u64) -> PyResult<Search> {
        let rows = u32s(rows)?;
        if rows.iter().any(|&r| r as usize >= self.env.len()) {
            return Err(err("no such table"));
        }
        let roots: Vec<&dyn AnyGame> = rows.iter().map(|&r| self.env.game(r as usize)).collect();
        Search::start(py, &roots, samples, seed)
    }

    /// `actions` is one little-endian u32 per table. Returns the rounds that ended.
    fn step<'py>(&mut self, py: Python<'py>, actions: &[u8]) -> PyResult<Bound<'py, PyDict>> {
        if actions.len() != 4 * self.env.len() {
            return Err(err("one u32 action per table is needed"));
        }
        let actions: Vec<u32> = actions.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
        let env = &mut self.env;
        let finished = py.detach(|| env.step(&actions)).map_err(err)?;
        let column = |f: &dyn Fn(&gamelab::vecenv::Finished) -> u32| finished.iter().map(f).collect::<Vec<u32>>();
        let d = PyDict::new(py);
        d.set_item("env", bytes(py, &column(&|f| f.env)))?;
        d.set_item("spec", bytes(py, &column(&|f| f.spec as u32)))?;
        d.set_item("players", bytes(py, &column(&|f| f.players as u32)))?;
        d.set_item("steps", bytes(py, &column(&|f| f.steps)))?;
        d.set_item("truncated", bytes(py, &column(&|f| f.truncated as u32)))?;
        d.set_item("control", bytes(py, &finished.iter().flat_map(|f| f.control).collect::<Vec<u8>>()))?;
        d.set_item("returns", bytes(py, &finished.iter().flat_map(|f| f.returns).collect::<Vec<f32>>()))?;
        d.set_item("stats", bytes(py, &finished.iter().flat_map(|f| f.stats).collect::<Vec<f32>>()))?;
        Ok(d)
    }
}

/// One round of one game, for play, search and inspection.
#[pyclass]
struct Round {
    game: Box<dyn AnyGame>,
}

#[pymethods]
impl Round {
    /// `rules` is JSON; pass the game's preset (see `games()`) for the standard rules.
    #[new]
    #[pyo3(signature = (game, rules, players, seed=0))]
    fn new(game: &str, rules: &str, players: usize, seed: u64) -> PyResult<Round> {
        let rules = serde_json::from_str(rules).map_err(err)?;
        Ok(Round { game: dynamic::create(game, &rules, players, seed).map_err(err)? })
    }

    #[getter]
    fn id(&self) -> &'static str {
        self.game.id()
    }
    #[getter]
    fn players(&self) -> usize {
        self.game.players()
    }
    #[getter]
    fn to_act(&self) -> Option<u8> {
        self.game.to_act()
    }
    #[getter]
    fn over(&self) -> bool {
        self.game.is_over()
    }
    #[getter]
    fn legal(&self) -> usize {
        self.game.legal()
    }
    fn rules(&self) -> String {
        self.game.rules().to_string()
    }
    /// The legal actions as a JSON list, in the order of the action tokens.
    fn legal_json(&self) -> String {
        serde_json::Value::from(self.game.legal_json()).to_string()
    }
    fn returns(&self) -> Vec<f32> {
        self.game.returns()
    }
    fn stats(&self) -> Vec<f32> {
        self.game.stats()
    }
    fn observe<'py>(&self, py: Python<'py>, seat: u8, omniscient: bool) -> PyResult<Bound<'py, PyDict>> {
        if seat as usize >= self.game.players() {
            return Err(err("no such seat"));
        }
        let mut obs = Obs::default();
        self.game.observe(seat, omniscient, &mut obs);
        obs_dict(py, &obs)
    }
    fn step(&mut self, index: usize) -> PyResult<()> {
        self.game.step(index).map_err(err)
    }
    /// An action given as JSON, by any seat.
    fn apply(&mut self, seat: u8, action: &str) -> PyResult<()> {
        let action = serde_json::from_str(action).map_err(err)?;
        self.game.apply_json(seat, &action).map_err(err)
    }
    /// A round `seat` cannot tell from this one, with the hidden cards dealt again.
    fn determinize(&self, seat: u8, seed: u64) -> PyResult<Round> {
        if seat as usize >= self.game.players() {
            return Err(err("no such seat"));
        }
        Ok(Round { game: self.game.determinize(seat, &mut Rng::from_u64(seed)) })
    }
    fn copy(&self) -> Round {
        Round { game: self.game.boxed() }
    }
}

/// A small game written out in full, to score a player exactly.
#[pyclass]
struct Exact {
    tree: Tree,
}

impl Exact {
    fn strategy(&self, probs: &[u8], width: usize) -> PyResult<Strategy> {
        let sets = &self.tree.infosets;
        if width == 0 || probs.len() != sets.len() * width * 8 {
            return Err(err("one row of f64 probabilities per information set is needed"));
        }
        let row = |i: usize, a: usize| f64::from_le_bytes(probs[(i * width + a) * 8..][..8].try_into().unwrap());
        sets.iter()
            .enumerate()
            .map(|(i, set)| {
                let p: Vec<f64> = (0..set.actions).map(|a| row(i, a)).collect();
                let sum: f64 = p.iter().sum();
                if set.actions > width || p.iter().any(|x| !(*x >= 0.0)) || (sum - 1.0).abs() > 1e-4 {
                    return Err(err(format!("row {i} is not a probability distribution over its actions")));
                }
                Ok(p.iter().map(|x| x / sum).collect())
            })
            .collect()
    }
}

#[pymethods]
impl Exact {
    #[new]
    #[pyo3(signature = (game, rules, players, node_limit=20_000_000))]
    fn new(game: &str, rules: &str, players: usize, node_limit: usize) -> PyResult<Exact> {
        let rules = serde_json::from_str(rules).map_err(err)?;
        Ok(Exact { tree: dynamic::exact_tree(game, &rules, players, node_limit).map_err(err)? })
    }

    #[getter]
    fn positions(&self) -> usize {
        self.tree.positions()
    }

    /// Every information set as one padded batch, like `Tables.observe`.
    fn infosets<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let sets = &self.tree.infosets;
        let max_tokens = sets.iter().map(|s| s.obs.tokens.len()).max().unwrap_or(0);
        let max_actions = sets.iter().map(|s| s.obs.actions.len()).max().unwrap_or(0);
        let mut tokens = vec![0u16; sets.len() * max_tokens * FIELDS];
        let mut actions = vec![0u16; sets.len() * max_actions * ACTION_FIELDS];
        for (i, s) in sets.iter().enumerate() {
            for (j, t) in s.obs.tokens.iter().enumerate() {
                tokens[(i * max_tokens + j) * FIELDS..][..FIELDS].copy_from_slice(&t.0);
            }
            for (j, a) in s.obs.actions.iter().enumerate() {
                let row = [a.verb, a.args[0], a.args[1], a.args[2], a.param];
                actions[(i * max_actions + j) * ACTION_FIELDS..][..ACTION_FIELDS].copy_from_slice(&row);
            }
        }
        let d = PyDict::new(py);
        d.set_item("n", sets.len())?;
        d.set_item("max_tokens", max_tokens)?;
        d.set_item("max_actions", max_actions)?;
        d.set_item("tokens", bytes(py, &tokens))?;
        d.set_item("actions", bytes(py, &actions))?;
        d.set_item("token_count", bytes(py, &sets.iter().map(|s| s.obs.tokens.len() as u16).collect::<Vec<_>>()))?;
        d.set_item("action_count", bytes(py, &sets.iter().map(|s| s.actions as u16).collect::<Vec<_>>()))?;
        d.set_item("seat", bytes(py, &sets.iter().map(|s| s.seat).collect::<Vec<u8>>()))?;
        Ok(d)
    }

    /// `probs` is f64 [information sets, width], row `i` over the actions of set `i`.
    /// Returns (value per seat, exploitability).
    fn score(&self, py: Python<'_>, probs: &[u8], width: usize) -> PyResult<(Vec<f64>, f64)> {
        let strategy = self.strategy(probs, width)?;
        let tree = &self.tree;
        Ok(py.detach(|| (tree.values(&strategy), tree.exploitability(&strategy))))
    }

    /// An equilibrium by CFR+, as f64 rows padded to the widest information set.
    fn solve<'py>(&self, py: Python<'py>, iterations: usize) -> (Bound<'py, PyBytes>, usize) {
        let tree = &self.tree;
        let strategy = py.detach(|| tree.solve(iterations));
        let width = strategy.iter().map(|r| r.len()).max().unwrap_or(0);
        let flat: Vec<f64> = strategy.iter().flat_map(|r| (0..width).map(|a| r.get(a).copied().unwrap_or(0.0))).collect();
        (bytes(py, &flat), width)
    }
}

/// Every game with its settings and presets, as JSON.
#[pyfunction]
fn games() -> String {
    serde_json::to_string(&dynamic::games()).unwrap()
}

/// Rules drawn at random around `base` (JSON) that the game accepts.
#[pyfunction]
fn sample_rules(game: &str, base: &str, players: usize, seed: u64) -> PyResult<String> {
    let base = serde_json::from_str(base).map_err(err)?;
    let rules = dynamic::sample_rules(game, &base, players, &mut Rng::from_u64(seed)).map_err(err)?;
    Ok(rules.to_string())
}

#[pymodule]
fn _core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Tables>()?;
    m.add_class::<Round>()?;
    m.add_class::<Exact>()?;
    m.add_class::<Search>()?;
    m.add_function(wrap_pyfunction!(games, m)?)?;
    m.add_function(wrap_pyfunction!(sample_rules, m)?)?;
    m.add("FIELDS", FIELDS)?;
    m.add("FIELD_SIZE", FIELD_SIZE.to_vec())?;
    m.add("ACTION_FIELDS", ACTION_FIELDS)?;
    m.add("MAX_SEATS", MAX_SEATS)?;
    m.add("MAX_STATS", MAX_STATS)?;
    m.add("GAME_BLOCK", GAME_BLOCK)?;
    m.add("NO_ARG", NO_ARG)?;
    Ok(())
}
