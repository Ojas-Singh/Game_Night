//! Checks that hold for every game, run on random playouts.
//!
//! * the seat to move always has a legal action and every legal action is
//!   accepted;
//! * the observation lists exactly the legal actions;
//! * a re-deal of the hidden cards (`determinize`) looks the same to the seat
//!   it was made for, and can be played to the end;
//! * the round ends and the returns sum to zero;
//! * the state survives a round trip through JSON.

use crate::game::Game;
use crate::obs::{Obs, FIELD_SIZE, NO_ARG};
use crate::rng::Rng;
use crate::settings::{check_rules, random_rules};
use serde::{de::DeserializeOwned, Serialize};

#[derive(Debug, Default)]
pub struct Report {
    pub games: u64,
    pub steps: u64,
    pub max_tokens: usize,
    pub max_actions: usize,
    /// Rule sets drawn at random that the game refused (e.g. too many cards).
    pub rules_refused: u64,
}

/// Build rules from a JSON object, refusing anything outside the settings.
pub fn rules_from_json<G: Game>(rules: &serde_json::Value) -> Result<G::Rules, String> {
    check_rules(&G::settings(), rules)?;
    serde_json::from_value(rules.clone()).map_err(|e| e.to_string())
}

fn check_obs<G: Game>(g: &G, obs: &Obs, legal: usize, acting: bool) -> Result<(), String> {
    for t in &obs.tokens {
        if t.0.iter().zip(FIELD_SIZE).any(|(&v, max)| v >= max) {
            return Err(format!("token out of range: {t:?}"));
        }
    }
    if acting && obs.actions.len() != legal {
        return Err(format!("{} action tokens for {} legal actions", obs.actions.len(), legal));
    }
    if !acting && !obs.actions.is_empty() {
        return Err("action tokens for a seat that is not to move".into());
    }
    for a in &obs.actions {
        if a.args.iter().any(|&i| i != NO_ARG && i as usize >= obs.tokens.len()) {
            return Err(format!("action argument points outside the tokens: {a:?}"));
        }
        if a.verb / crate::obs::GAME_BLOCK != G::NUMBER {
            return Err(format!("verb outside the game's block: {a:?}"));
        }
    }
    for i in 0..obs.actions.len() {
        if obs.actions[..i].contains(&obs.actions[i]) {
            return Err(format!("two legal actions look the same: {:?}", obs.actions[i]));
        }
    }
    let _ = g;
    Ok(())
}

fn play_out<G: Game>(mut g: G, rng: &mut Rng, limit: usize) -> Result<G, String> {
    let mut legal = Vec::new();
    for _ in 0..limit {
        let Some(seat) = g.to_act() else { return Ok(g) };
        g.legal_actions(&mut legal);
        if legal.is_empty() {
            return Err("no legal action".into());
        }
        let a = legal[rng.int(legal.len())].clone();
        g.apply(seat, &a).map_err(|e| format!("legal action {a:?} refused: {e}"))?;
    }
    Err(format!("no end after {limit} steps"))
}

/// Play `games` random games with random rules and player counts.
/// `adjust` may edit each random rules object (e.g. to force a turn limit,
/// without which random play need not end). `step_limit` bounds one game; a
/// game that is still running then fails.
pub fn fuzz<G>(
    games: u64,
    seed: u32,
    players: std::ops::RangeInclusive<usize>,
    step_limit: usize,
    adjust: impl Fn(&mut serde_json::Value, &mut Rng),
) -> Result<Report, String>
where
    G: Game + Serialize + DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let mut rng = Rng::new(seed);
    let settings = G::settings();
    let defaults = serde_json::to_value(G::Rules::default()).map_err(|e| e.to_string())?;
    check_rules(&settings, &defaults).map_err(|e| format!("default rules: {e}"))?;
    let mut report = Report::default();
    let (mut obs, mut obs2, mut legal) = (Obs::default(), Obs::default(), Vec::new());
    let span = players.end() - players.start() + 1;

    while report.games < games {
        let n = players.start() + rng.int(span);
        let mut json = random_rules(&settings, &defaults, &mut rng);
        adjust(&mut json, &mut rng);
        let rules = rules_from_json::<G>(&json)?;
        let mut g = match G::new(&rules, n, rng.fork()) {
            Ok(g) => g,
            Err(_) => {
                report.rules_refused += 1;
                continue;
            }
        };
        let fail = |g: &G, why: String| format!("{why}\nrules {json}\nstate {g:?}");
        let mut steps = 0;
        while let Some(seat) = g.to_act() {
            if steps >= step_limit {
                return Err(fail(&g, format!("no end after {step_limit} steps")));
            }
            g.legal_actions(&mut legal);
            if legal.is_empty() {
                return Err(fail(&g, format!("no legal action for seat {seat}")));
            }
            for p in 0..n as u8 {
                g.observe(p, false, &mut obs);
                check_obs(&g, &obs, legal.len(), p == seat).map_err(|e| fail(&g, e))?;
                report.max_tokens = report.max_tokens.max(obs.tokens.len());
                report.max_actions = report.max_actions.max(obs.actions.len());
            }
            // Now and then: re-deal the hidden cards for a random seat.
            if rng.int(8) == 0 {
                let p = rng.int(n) as u8;
                let d = g.determinize(p, &mut rng);
                g.observe(p, false, &mut obs);
                d.observe(p, false, &mut obs2);
                if obs != obs2 {
                    return Err(fail(&g, format!("seat {p} can tell a re-deal apart\nre-deal {d:?}")));
                }
                play_out(d.clone(), &mut rng, step_limit).map_err(|e| fail(&d, format!("re-deal: {e}")))?;
            }
            if rng.int(64) == 0 {
                let text = serde_json::to_string(&g).map_err(|e| e.to_string())?;
                let back: G = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                if back != g {
                    return Err(fail(&g, "state changed in a JSON round trip".into()));
                }
            }
            g.observe(seat, true, &mut obs);
            check_obs(&g, &obs, legal.len(), true).map_err(|e| fail(&g, e))?;
            let a = legal[rng.int(legal.len())].clone();
            g.apply(seat, &a).map_err(|e| fail(&g, format!("legal action {a:?} refused: {e}")))?;
            steps += 1;
        }
        g.legal_actions(&mut legal);
        if !legal.is_empty() {
            return Err(fail(&g, "legal actions after the end".into()));
        }
        let returns = g.returns();
        if returns.len() != n || returns.iter().sum::<f32>().abs() > 1e-4 {
            return Err(fail(&g, format!("returns {returns:?} are not zero-sum")));
        }
        report.games += 1;
        report.steps += steps as u64;
    }
    Ok(report)
}
