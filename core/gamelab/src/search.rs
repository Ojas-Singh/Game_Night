//! Looking ahead from a position, for play that is stronger than the bare
//! network.
//!
//! The player cannot see the hidden cards, so the search deals them again in
//! several ways that fit what the player has seen (`determinize`). In each
//! deal it tries every legal action, giving one *leaf* per deal and action.
//! The caller may play the leaves on for a few moves with its network
//! (`observe`, `step`), then scores them with its value network on the open
//! position (`observe(true)`); `finish` averages the scores over the deals
//! into one value per action for the player at the root.
//!
//! The value network judges how the game goes on when everyone keeps playing
//! as the network does, so the result is the worth of each action against
//! that play, not against opponents who can see the cards. The deals are
//! drawn evenly from those the player cannot rule out; what the opponents'
//! earlier moves say about their cards is not weighed in.

use crate::dynamic::AnyGame;
use crate::game::Seat;
use crate::obs::Obs;
use crate::rng::Rng;
use crate::vecenv::{Batch, MAX_SEATS};
use rayon::prelude::*;

struct Root {
    seat: Seat,
    game: u16,
    actions: usize,
    /// Deals tried.
    samples: usize,
}

struct Leaf {
    game: Box<dyn AnyGame>,
    root: u32,
    action: u16,
    obs: Obs,
}

pub struct Search {
    roots: Vec<Root>,
    leaves: Vec<Leaf>,
    /// The leaves still in play, as indices into `leaves`.
    live: Vec<u32>,
}

/// One value per action of each root, padded to `max_actions`.
pub struct Values {
    pub max_actions: usize,
    /// `roots * max_actions`.
    pub q: Vec<f32>,
    /// Deals behind each root's values.
    pub samples: Vec<u32>,
}

impl Search {
    /// Try every action of the seat to move in `samples` deals of each root.
    /// Each root has its own random generator, so the result is the same on
    /// any number of threads.
    pub fn new(roots: &[&dyn AnyGame], samples: usize, seed: u64) -> Result<Search, String> {
        if roots.iter().any(|g| g.is_over()) {
            return Err("a finished round cannot be searched".into());
        }
        let mut master = Rng::from_u64(seed);
        let rngs: Vec<Rng> = roots.iter().map(|_| master.fork()).collect();
        let grown: Vec<(Root, Vec<Leaf>)> = roots
            .par_iter()
            .zip(rngs)
            .enumerate()
            .map(|(r, (g, mut rng))| {
                let seat = g.to_act().unwrap();
                let actions = g.legal();
                let mut root = Root { seat, game: g.number(), actions, samples: 0 };
                let mut leaves = Vec::with_capacity(samples * actions);
                for _ in 0..samples {
                    let deal = g.determinize(seat, &mut rng);
                    // The player's choices never depend on cards it cannot
                    // see; a deal that disagrees is left out.
                    if deal.to_act() != Some(seat) || deal.legal() != actions {
                        continue;
                    }
                    root.samples += 1;
                    for a in 0..actions {
                        let mut game = deal.boxed();
                        game.step(a).expect("a legal action");
                        leaves.push(Leaf { game, root: r as u32, action: a as u16, obs: Obs::default() });
                    }
                }
                (root, leaves)
            })
            .collect();
        let mut s = Search { roots: Vec::new(), leaves: Vec::new(), live: Vec::new() };
        for (root, leaves) in grown {
            s.roots.push(root);
            s.leaves.extend(leaves);
        }
        s.refresh();
        Ok(s)
    }

    fn refresh(&mut self) {
        self.live = (0..self.leaves.len() as u32).filter(|&i| !self.leaves[i as usize].game.is_over()).collect();
    }

    /// Leaves still in play: the rows of `observe`, `step` and `finish`.
    pub fn live(&self) -> usize {
        self.live.len()
    }

    /// What the seat to move sees at every leaf still in play. `control` and
    /// `spec` are zero.
    pub fn observe(&mut self, omniscient: bool, out: &mut Batch) {
        self.leaves.par_iter_mut().with_min_len(64).for_each(|l| {
            if let Some(seat) = l.game.to_act() {
                l.game.observe(seat, omniscient, &mut l.obs);
            }
        });
        let live: Vec<&Leaf> = self.live.iter().map(|&i| &self.leaves[i as usize]).collect();
        out.pack(&live.iter().map(|l| &l.obs).collect::<Vec<_>>());
        out.seat = live.iter().map(|l| l.game.to_act().unwrap()).collect();
        out.players = live.iter().map(|l| l.game.players() as u8).collect();
        out.game = live.iter().map(|l| l.game.number() as u8).collect();
        out.control = vec![0; live.len()];
        out.spec = vec![0; live.len()];
    }

    /// Play one more action at every leaf still in play.
    pub fn step(&mut self, actions: &[u32]) -> Result<(), String> {
        if actions.len() != self.live.len() {
            return Err(format!("{} actions for {} leaves", actions.len(), self.live.len()));
        }
        let mut next = actions.iter();
        let mut live = self.live.iter().peekable();
        let chosen: Vec<Option<u32>> = (0..self.leaves.len() as u32)
            .map(|i| live.next_if_eq(&&i).and_then(|_| next.next().copied()))
            .collect();
        self.leaves.par_iter_mut().zip(chosen).with_min_len(64).try_for_each(|(l, a)| match a {
            Some(a) => l.game.step(a as usize).map_err(|e| format!("action {a}: {e}")),
            None => Ok(()),
        })?;
        self.refresh();
        Ok(())
    }

    /// The value of each action to the player at its root.
    ///
    /// `values` has `MAX_SEATS` numbers per leaf still in play: the value for
    /// each seat, counted from the seat to move at that leaf. A leaf whose
    /// round has ended counts with its result divided by `scale[game number]`
    /// (1 when absent), which puts it in the units of `values`.
    pub fn finish(&self, values: &[f32], scale: &[f32]) -> Result<Values, String> {
        if values.len() != self.live.len() * MAX_SEATS {
            return Err(format!("{} values for {} leaves", values.len() / MAX_SEATS, self.live.len()));
        }
        let max_actions = self.roots.iter().map(|r| r.actions).max().unwrap_or(0);
        let mut q = vec![0.0f32; self.roots.len() * max_actions];
        let mut add = |l: &Leaf, v: f32| q[l.root as usize * max_actions + l.action as usize] += v;
        let mut row = 0;
        for (i, l) in self.leaves.iter().enumerate() {
            let root = &self.roots[l.root as usize];
            if self.live.get(row) == Some(&(i as u32)) {
                let (n, at) = (l.game.players(), l.game.to_act().unwrap() as usize);
                add(l, values[row * MAX_SEATS + (root.seat as usize + n - at) % n]);
                row += 1;
            } else {
                let unit = scale.get(root.game as usize).copied().unwrap_or(1.0);
                add(l, l.game.returns()[root.seat as usize] / unit);
            }
        }
        for (r, root) in self.roots.iter().enumerate() {
            let n = root.samples.max(1) as f32;
            q[r * max_actions..][..root.actions].iter_mut().for_each(|v| *v /= n);
        }
        Ok(Values { max_actions, q, samples: self.roots.iter().map(|r| r.samples as u32).collect() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dynamic::{create, games, info};

    fn play(threads: usize) -> Vec<f32> {
        let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
        pool.install(|| {
            let mut rng = Rng::new(11);
            let mut roots = Vec::new();
            for g in games() {
                for round in 0..6 {
                    let mut game = create(g.id, &g.presets[0].1, g.min_players, round).unwrap();
                    for _ in 0..rng.int(30) {
                        if game.is_over() {
                            break;
                        }
                        game.step(rng.int(game.legal())).unwrap();
                    }
                    if !game.is_over() {
                        roots.push(game);
                    }
                }
            }
            let refs: Vec<&dyn AnyGame> = roots.iter().map(|g| &**g).collect();
            let mut search = Search::new(&refs, 5, 3).unwrap();
            let mut batch = Batch::default();
            for depth in 0..3 {
                search.observe(depth == 2, &mut batch);
                assert_eq!(batch.n, search.live());
                assert!(batch.action_count.iter().all(|&a| a > 0));
                let actions: Vec<u32> = batch.action_count.iter().map(|&a| rng.int(a as usize) as u32).collect();
                search.step(&actions).unwrap();
            }
            // A stand-in for the value network: seat `i` from the mover is worth `i`.
            let values: Vec<f32> = (0..search.live() * MAX_SEATS).map(|i| (i % MAX_SEATS) as f32).collect();
            let out = search.finish(&values, &[]).unwrap();
            assert!(out.samples.iter().all(|&s| s == 5));
            assert_eq!(out.q.len(), roots.len() * out.max_actions);
            out.q
        })
    }

    #[test]
    fn a_search_is_the_same_on_any_number_of_threads() {
        assert_eq!(play(1), play(4));
    }

    #[test]
    fn folding_costs_what_was_put_in() {
        let rules = &info("minipoker").unwrap().presets.iter().find(|p| p.0 == "Kuhn poker").unwrap().1.clone();
        let mut game = create("minipoker", rules, 2, 1).unwrap();
        let bet = game.legal_json().iter().position(|a| a["type"] == "BET").expect("the first player may bet");
        game.step(bet).unwrap();
        let fold = game.legal_json().iter().position(|a| a["type"] == "FOLD").unwrap();
        let search = Search::new(&[&*game], 8, 0).unwrap();
        // Both answers to a bet end the round in Kuhn poker.
        assert_eq!(search.live(), 0);
        let out = search.finish(&[], &[1.0; 16]).unwrap();
        assert_eq!(out.q[fold], -1.0);
        assert!(out.q[1 - fold] >= -2.0 && out.q[1 - fold] <= 2.0);
    }
}
