//! Exact tools for games small enough to write out in full.
//!
//! A `Tree` holds every position reachable from a list of deals, grouped into
//! information sets (positions the player to move cannot tell apart, i.e. with
//! the same observation). On it we can compute, with no sampling error:
//!
//! * the value of a strategy for every seat;
//! * the best reply to a strategy and from it the *exploitability*: how much
//!   per game a perfect opponent would win from it. Zero means unbeatable;
//! * an equilibrium, by counterfactual regret minimisation (CFR+).
//!
//! The observation is the information-set key, so these tools also check that
//! a game's observation holds everything the player knows and nothing more. A
//! learned player is scored by asking it for its move probabilities at every
//! `InfoSet::obs`.

use crate::game::{Game, Seat};
use crate::obs::Obs;
use std::collections::HashMap;

/// A game whose deals can be listed, and which is deterministic after the deal.
pub trait Enumerable: Game {
    /// Every initial position with its probability.
    fn roots(rules: &Self::Rules, players: usize) -> Result<Vec<(Self, f64)>, String>;
}

pub struct InfoSet {
    pub seat: Seat,
    /// What the seat sees, including its legal actions.
    pub obs: Obs,
    pub actions: usize,
}

enum Node {
    End(Vec<f64>),
    Decision { infoset: usize, children: Vec<usize> },
}

pub struct Tree {
    pub players: usize,
    pub infosets: Vec<InfoSet>,
    nodes: Vec<Node>,
    roots: Vec<(usize, f64)>,
}

/// Move probabilities for every information set, indexed like `Tree::infosets`.
pub type Strategy = Vec<Vec<f64>>;

impl Tree {
    /// Write out the game from `roots`. Fails past `node_limit` positions.
    pub fn build<G: Game>(roots: Vec<(G, f64)>, node_limit: usize) -> Result<Tree, String> {
        let players = roots.first().ok_or("no deals")?.0.players();
        let mut tree = Tree { players, infosets: Vec::new(), nodes: Vec::new(), roots: Vec::new() };
        let mut index: HashMap<(Seat, Obs), usize> = HashMap::new();
        for (g, p) in roots {
            let node = tree.add(g, &mut index, node_limit)?;
            tree.roots.push((node, p));
        }
        Ok(tree)
    }

    fn add<G: Game>(&mut self, g: G, index: &mut HashMap<(Seat, Obs), usize>, limit: usize) -> Result<usize, String> {
        if self.nodes.len() >= limit {
            return Err(format!("the game has more than {limit} positions"));
        }
        let Some(seat) = g.to_act() else {
            self.nodes.push(Node::End(g.returns().into_iter().map(f64::from).collect()));
            return Ok(self.nodes.len() - 1);
        };
        let mut legal = Vec::new();
        g.legal_actions(&mut legal);
        let mut obs = Obs::default();
        g.observe(seat, false, &mut obs);
        if obs.actions.len() != legal.len() {
            return Err("the observation does not list the legal actions".into());
        }
        let infoset = match index.get(&(seat, obs.clone())) {
            Some(&i) => i,
            None => {
                self.infosets.push(InfoSet { seat, obs: obs.clone(), actions: legal.len() });
                index.insert((seat, obs), self.infosets.len() - 1);
                self.infosets.len() - 1
            }
        };
        let mut children = Vec::with_capacity(legal.len());
        for a in &legal {
            let mut next = g.clone();
            next.apply(seat, a).map_err(|e| format!("legal action {a:?} refused: {e}"))?;
            children.push(self.add(next, index, limit)?);
        }
        self.nodes.push(Node::Decision { infoset, children });
        Ok(self.nodes.len() - 1)
    }

    pub fn positions(&self) -> usize {
        self.nodes.len()
    }

    /// Every move equally likely.
    pub fn uniform(&self) -> Strategy {
        self.infosets.iter().map(|i| vec![1.0 / i.actions as f64; i.actions]).collect()
    }

    /// Expected return of each seat when everyone plays `strategy`.
    pub fn values(&self, strategy: &Strategy) -> Vec<f64> {
        let mut total = vec![0.0; self.players];
        for &(root, p) in &self.roots {
            self.add_values(root, p, strategy, &mut total);
        }
        total
    }

    fn add_values(&self, node: usize, reach: f64, strategy: &Strategy, total: &mut [f64]) {
        match &self.nodes[node] {
            Node::End(returns) => total.iter_mut().zip(returns).for_each(|(t, r)| *t += reach * r),
            Node::Decision { infoset, children } => {
                for (a, &child) in children.iter().enumerate() {
                    let p = strategy[*infoset][a];
                    if p > 0.0 {
                        self.add_values(child, reach * p, strategy, total);
                    }
                }
            }
        }
    }

    /// The most `seat` can win on average against the others playing `strategy`.
    pub fn best_response(&self, strategy: &Strategy, seat: Seat) -> f64 {
        // Positions of each of the seat's information sets, weighted by the
        // chance of the deal and of the other players' moves leading there.
        let mut members: Vec<Vec<(usize, f64)>> = vec![Vec::new(); self.infosets.len()];
        let mut stack: Vec<(usize, f64)> = self.roots.clone();
        while let Some((node, w)) = stack.pop() {
            if let Node::Decision { infoset, children } = &self.nodes[node] {
                let own = self.infosets[*infoset].seat == seat;
                if own {
                    members[*infoset].push((node, w));
                }
                for (a, &child) in children.iter().enumerate() {
                    let w = if own { w } else { w * strategy[*infoset][a] };
                    if w > 0.0 {
                        stack.push((child, w));
                    }
                }
            }
        }
        let mut best = vec![usize::MAX; self.infosets.len()];
        self.roots.iter().map(|&(root, p)| p * self.reply_value(root, seat, strategy, &members, &mut best)).sum()
    }

    fn reply_value(
        &self,
        node: usize,
        seat: Seat,
        strategy: &Strategy,
        members: &[Vec<(usize, f64)>],
        best: &mut Vec<usize>,
    ) -> f64 {
        match &self.nodes[node] {
            Node::End(returns) => returns[seat as usize],
            Node::Decision { infoset, children } => {
                let i = *infoset;
                if self.infosets[i].seat != seat {
                    return children
                        .iter()
                        .enumerate()
                        .filter(|(a, _)| strategy[i][*a] > 0.0)
                        .map(|(a, &c)| strategy[i][a] * self.reply_value(c, seat, strategy, members, best))
                        .sum();
                }
                if best[i] == usize::MAX {
                    // One move for the whole information set: the one that is
                    // best over all the positions it may be.
                    let mut top = (0, f64::NEG_INFINITY);
                    for a in 0..self.infosets[i].actions {
                        let mut v = 0.0;
                        for &(m, w) in &members[i] {
                            let Node::Decision { children, .. } = &self.nodes[m] else { unreachable!() };
                            v += w * self.reply_value(children[a], seat, strategy, members, best);
                        }
                        if v > top.1 {
                            top = (a, v);
                        }
                    }
                    best[i] = top.0;
                }
                self.reply_value(children[best[i]], seat, strategy, members, best)
            }
        }
    }

    /// Average over the seats of what a best reply gains over the strategy's
    /// own value. For two players this is the amount per game a perfect
    /// opponent wins from the strategy, averaged over both seats.
    pub fn exploitability(&self, strategy: &Strategy) -> f64 {
        let values = self.values(strategy);
        (0..self.players).map(|p| self.best_response(strategy, p as Seat) - values[p]).sum::<f64>() / self.players as f64
    }

    /// An equilibrium strategy by CFR+ (exact for two players; a reasonable
    /// strategy with no guarantee for more).
    pub fn solve(&self, iterations: usize) -> Strategy {
        let zero: Strategy = self.infosets.iter().map(|i| vec![0.0; i.actions]).collect();
        let (mut regret, mut average) = (zero.clone(), zero.clone());
        for t in 1..=iterations {
            for seat in 0..self.players as Seat {
                let current: Strategy = regret.iter().map(|r| normalised(r)).collect();
                let mut delta = zero.clone();
                for &(root, p) in &self.roots {
                    self.cfr(root, seat, 1.0, p, &current, &mut delta, &mut average, t as f64);
                }
                for (r, d) in regret.iter_mut().zip(&delta) {
                    r.iter_mut().zip(d).for_each(|(r, d)| *r = (*r + d).max(0.0));
                }
            }
        }
        average.iter().map(|a| normalised(a)).collect()
    }

    #[allow(clippy::too_many_arguments)]
    fn cfr(
        &self,
        node: usize,
        seat: Seat,
        own: f64,
        others: f64,
        current: &Strategy,
        delta: &mut Strategy,
        average: &mut Strategy,
        weight: f64,
    ) -> f64 {
        match &self.nodes[node] {
            Node::End(returns) => returns[seat as usize],
            Node::Decision { infoset, children } => {
                let i = *infoset;
                let probs = &current[i];
                if self.infosets[i].seat != seat {
                    return children
                        .iter()
                        .enumerate()
                        .filter(|(a, _)| probs[*a] > 0.0)
                        .map(|(a, &c)| {
                            probs[a] * self.cfr(c, seat, own, others * probs[a], current, delta, average, weight)
                        })
                        .sum();
                }
                let each: Vec<f64> = children
                    .iter()
                    .enumerate()
                    .map(|(a, &c)| self.cfr(c, seat, own * probs[a], others, current, delta, average, weight))
                    .collect();
                let value: f64 = each.iter().zip(probs).map(|(v, p)| v * p).sum();
                for a in 0..children.len() {
                    delta[i][a] += others * (each[a] - value);
                    average[i][a] += weight * own * probs[a];
                }
                value
            }
        }
    }
}

/// Probabilities in proportion to the positive entries; uniform when there are none.
fn normalised(weights: &[f64]) -> Vec<f64> {
    let sum: f64 = weights.iter().filter(|w| **w > 0.0).sum();
    if sum > 0.0 {
        weights.iter().map(|w| w.max(0.0) / sum).collect()
    } else {
        vec![1.0 / weights.len() as f64; weights.len()]
    }
}
