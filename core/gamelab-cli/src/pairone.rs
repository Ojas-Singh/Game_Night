//! Pair One traces for the comparison with the TypeScript engine.

use gamelab::games::pairone::{PairOne, PairOneAction, PairOneRules};
use gamelab::{Game, Rng, Seat};
use serde_json::json;
use std::io::Write;

pub fn trace(games: u64, seed: u32) {
    let out = std::io::stdout();
    let mut out = std::io::BufWriter::new(out.lock());
    let mut r = Rng::new(seed);
    let rules = PairOneRules::default();
    let (mut finished, mut steps_total, mut rejected) = (0u64, 0u64, 0u64);
    let mut legal = Vec::new();
    for game in 0..games {
        let players = 2 + r.int(5);
        let game_seed = r.next_u32();
        let mut g = PairOne::new(&rules, players, Rng::ts_compat(game_seed)).unwrap();
        let mut steps = Vec::new();
        for _ in 0..20_000 {
            if g.is_over() {
                break;
            }
            // Mostly a legal flip; sometimes any seat and any position.
            let (seat, action) = if r.int(100) < 85 {
                g.legal_actions(&mut legal);
                (g.turn, legal[r.int(legal.len())])
            } else {
                (r.int(players) as Seat, PairOneAction::Flip { slot: r.int(56) as u8 })
            };
            let ok = g.apply(seat, &action).is_ok();
            rejected += !ok as u64;
            steps.push(json!({ "seat": seat, "action": action, "ok": ok, "state": g.ts_snapshot() }));
        }
        finished += g.is_over() as u64;
        steps_total += steps.len() as u64;
        writeln!(out, "{}", json!({ "game": game, "players": players, "seed": game_seed, "steps": steps })).unwrap();
    }
    eprintln!("{games} games, {finished} finished, {steps_total} steps, {rejected} rejected");
}
