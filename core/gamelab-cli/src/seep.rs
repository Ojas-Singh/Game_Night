//! Seep traces for the comparison with the TypeScript engine, and timed
//! simulation-mode playouts.

use gamelab::games::seep::{DealerPolicy, Phase, Seep, SeepAction, SeepRules};
use gamelab::{Rng, Seat};
use serde_json::json;
use std::io::Write;

fn random_rules(r: &mut Rng) -> SeepRules {
    let mut rules = if r.int(4) == 0 { SeepRules::casual() } else { SeepRules::default() };
    // A short baazi most of the time, so that matches end within the trace.
    rules.baazi_lead_target = [100, 40, 15, 1 + r.int(60) as u16][r.int(4)];
    if r.int(3) == 0 {
        return rules;
    }
    rules.opening_hand_cards = [4, 4, 1 + r.int(12) as u8][r.int(3)];
    rules.table_start_cards = [4, 4, r.int(5) as u8][r.int(3)];
    rules.cards_per_batch = [4, 1 + r.int(12) as u8][r.int(2)];
    if r.int(2) == 0 {
        rules.min_house_total = 2 + r.int(12) as u8;
        rules.max_house_total = rules.min_house_total + r.int(14 - rules.min_house_total as usize) as u8;
    }
    rules.sweep_bonus = [50, r.int(101) as u16][r.int(2)];
    rules.first_play_sweep_bonus = [25, r.int(101) as u16][r.int(2)];
    rules.last_play_sweep_zero = r.int(2) == 0;
    rules.ten_diamonds_points = r.int(11) as u8;
    rules.majority_cards_bonus = r.int(11) as u8;
    rules.minimum_deal_points = [9, 0, r.int(31) as u16][r.int(3)];
    rules.dealer_policy = [DealerPolicy::LosingTeamStays, DealerPolicy::RotateRight][r.int(2)];
    rules
}

/// A play put together at random from what is in the hand and on the floor;
/// most are refused. `wild` also allows cards and houses that are not there.
fn shaped(g: &Seep, seat: Seat, r: &mut Rng, wild: bool) -> SeepAction {
    use SeepAction::*;
    let hand = g.hands.get(seat as usize).map_or(0, Vec::len);
    let card = r.int(hand.max(1) + wild as usize * 2) as u8;
    let floor = g.loose.len() + wild as usize;
    let mut loose = 0u32;
    if floor > 0 {
        for _ in 0..r.int(4) {
            loose |= 1 << r.int(floor);
        }
    }
    let total = match g.houses.len() {
        n if n > 0 && !(wild && r.int(3) == 0) => g.houses[r.int(n)].total,
        _ => 1 + r.int(15) as u8,
    };
    match r.int(6) {
        0 => Announce { value: 1 + r.int(14) as u8 },
        1 => Lay { card },
        2 => Capture { card, loose },
        3 => Build { card, loose, total: if r.int(2) == 0 { total } else { 2 + r.int(12) as u8 } },
        4 => Add { card, total, loose },
        _ => Break { card, total },
    }
}

pub fn trace(games: u64, seed: u32) {
    let out = std::io::stdout();
    let mut out = std::io::BufWriter::new(out.lock());
    let mut r = Rng::new(seed);
    let mut legal = Vec::new();
    let (mut finished, mut steps_total, mut rejected, mut deals) = (0u64, 0u64, 0u64, 0u64);
    for game in 0..games {
        let rules = random_rules(&mut r);
        let game_seed = r.next_u32();
        let mut g = match Seep::deal(&rules, 4, Rng::ts_compat(game_seed), false) {
            Ok(g) => g,
            Err(_) => continue,
        };
        let mut steps = Vec::new();
        for _ in 0..1500 {
            if g.phase == Phase::MatchComplete && r.int(4) != 0 {
                break;
            }
            let roll = r.int(100);
            let (seat, action) = if roll < 6 {
                // Anything from anyone, now and then from a seat that does not exist.
                let seats = if r.int(8) == 0 { 6 } else { 4 };
                let seat = r.int(seats) as Seat;
                (seat, if r.int(5) == 0 { SeepAction::NextDeal } else { shaped(&g, seat, &mut r, true) })
            } else if g.phase == Phase::DealComplete {
                (r.int(4) as Seat, SeepAction::NextDeal)
            } else if roll < 22 {
                (g.turn, shaped(&g, g.turn, &mut r, false))
            } else {
                g.legal_actions(&mut legal);
                match legal.is_empty() {
                    true => (g.turn, shaped(&g, g.turn, &mut r, true)),
                    false => (g.turn, legal[r.int(legal.len())]),
                }
            };
            let ok = g.apply(seat, &action).is_ok();
            rejected += !ok as u64;
            steps.push(json!({ "seat": seat, "action": action, "ok": ok, "state": g.ts_snapshot() }));
        }
        finished += (g.phase == Phase::MatchComplete) as u64;
        deals += g.deal_history.len() as u64;
        steps_total += steps.len() as u64;
        let line = json!({ "game": game, "seed": game_seed, "rules": rules.to_ts(), "steps": steps });
        writeln!(out, "{line}").unwrap();
    }
    eprintln!("{games} games, {finished} finished, {deals} deals, {steps_total} steps, {rejected} rejected");
}

pub fn bench(games: u64) {
    let rules = SeepRules::default();
    let mut r = Rng::new(7);
    let mut legal = Vec::new();
    let (mut steps, mut deals, mut wins) = (0u64, 0u64, [0u64; 2]);
    let start = std::time::Instant::now();
    for _ in 0..games {
        let mut g = Seep::deal(&rules, 4, r.fork(), true).unwrap();
        while let Some(seat) = g.to_act() {
            g.legal_actions(&mut legal);
            assert!(!legal.is_empty(), "no legal action for seat {seat}: {g:?}");
            let action = legal[r.int(legal.len())];
            g.apply(seat, &action).unwrap_or_else(|e| panic!("legal action refused: {e} {action:?}"));
            steps += 1;
        }
        deals += g.deal_history.len() as u64;
        wins[g.baazi_winner.unwrap() as usize] += 1;
    }
    let secs = start.elapsed().as_secs_f64();
    println!(
        "{games} baazis: {:.0} baazis/s, {:.0} deals/s, {:.2}M steps/s, {:.1} deals and {:.0} steps per baazi",
        games as f64 / secs,
        deals as f64 / secs,
        steps as f64 / secs / 1e6,
        deals as f64 / games as f64,
        steps as f64 / games as f64
    );
    println!("baazis won by team: {wins:?}");
}
