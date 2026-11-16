//! Command-line tools for the rules core.
//!
//!   gamelab cabo-trace <games> [seed]   random live-mode games as JSON lines, for
//!                                       replay against the TypeScript engine
//!   gamelab cabo-bench <games> [players] random simulation-mode playouts, timed
//!   gamelab pairone-trace <games> [seed] random Pair One games as JSON lines
//!   gamelab seep-trace <games> [seed]    the same for Seep
//!   gamelab seep-bench <games>           random simulation-mode baazis, timed

use gamelab::games::cabo::{Cabo, CaboAction, CaboRules, Phase, Power};
use gamelab::{Rng, Seat};
use serde_json::json;
use std::io::Write;

mod pairone;
mod seep;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let num = |i: usize, default: u64| args.get(i).and_then(|s| s.parse().ok()).unwrap_or(default);
    match args.first().map(String::as_str) {
        Some("cabo-trace") => cabo_trace(num(1, 100), num(2, 1) as u32),
        Some("cabo-bench") => cabo_bench(num(1, 10_000), num(2, 4) as usize),
        Some("cabo-bot") => cabo_bot(num(1, 2_000), num(2, 2) as usize),
        Some("pairone-trace") => pairone::trace(num(1, 100), num(2, 1) as u32),
        Some("seep-trace") => seep::trace(num(1, 100), num(2, 1) as u32),
        Some("seep-bench") => seep::bench(num(1, 1_000)),
        _ => {
            eprintln!("usage: gamelab cabo-trace <games> [seed] | cabo-bench <games> [players] | cabo-bot <games> [players] | pairone-trace <games> [seed] | seep-trace <games> [seed] | seep-bench <games>");
            std::process::exit(2);
        }
    }
}

// -------------------------------------------------------------------
// Traces for the comparison with the TypeScript engine
// -------------------------------------------------------------------

fn random_rules(r: &mut Rng) -> CaboRules {
    let mut rules = CaboRules::default();
    if r.int(3) == 0 {
        return rules;
    }
    rules.starting_cards = 3 + r.int(3) as u8;
    rules.initial_peek_cards = 1 + r.int(rules.starting_cards as usize) as u8;
    rules.wrong_flush_penalty = r.int(3) as u8;
    rules.reshuffle_discard = r.int(4) != 0;
    rules.end_round_when_player_out = r.int(4) == 0;
    rules.cabo_enabled = r.int(6) != 0;
    rules.caller_gets_final_turn = r.int(3) == 0;
    rules.others_final_turns = 1 + r.int(2) as u8;
    rules.black_king_value = r.int(5) as i8 - 2;
    if r.int(2) == 0 {
        let powers = [Power::None, Power::PeekOwn, Power::PeekOther, Power::BlindSwap];
        for p in rules.rank_powers.iter_mut() {
            *p = powers[r.int(4)];
        }
        for v in rules.rank_values.iter_mut() {
            *v = r.int(14) as i8 - 1;
        }
    }
    rules
}

fn occupied(g: &Cabo, seat: Seat) -> Vec<u8> {
    let hand = &g.hands[seat as usize];
    (0..hand.len()).filter(|&i| hand[i].is_some()).map(|i| i as u8).collect()
}

fn pick<T: Copy>(r: &mut Rng, items: &[T]) -> Option<T> {
    if items.is_empty() {
        None
    } else {
        Some(items[r.int(items.len())])
    }
}

/// Any action from any seat, valid or not.
fn garbage(g: &Cabo, r: &mut Rng) -> (Seat, CaboAction) {
    use CaboAction::*;
    let n = g.n as usize;
    let seat = r.int(n) as Seat;
    let target = r.int(n) as Seat;
    let slot = r.int(7) as u8;
    let action = match r.int(12) {
        0 => PeekStarting { slots: r.int(64) as u32 },
        1 => Draw,
        2 => Keep { slot },
        3 => DiscardDrawn,
        4 => PeekOwn { slot },
        5 => PeekOther { target, slot },
        6 => BlindSwap { own: r.int(7) as u8, target, slot },
        7 => FlushOwn { slots: r.int(64) as u32 },
        8 => FlushOther { target, slot },
        9 => Transfer { slot },
        10 => CallCabo,
        _ => EndTurn,
    };
    (seat, action)
}

/// A flush attempt; half the time one that will succeed, when there is one.
fn flush(g: &Cabo, r: &mut Rng) -> Option<(Seat, CaboAction)> {
    use CaboAction::*;
    let top = *g.discard.last()?;
    let n = g.n;
    let mut matches = Vec::new();
    let mut any = Vec::new();
    for p in 0..n {
        for s in occupied(g, p) {
            any.push((p, s));
            if g.hands[p as usize][s as usize].unwrap().rank() == top.rank() {
                matches.push((p, s));
            }
        }
    }
    let (owner, slot) = if r.int(2) == 0 { pick(r, &matches).or(pick(r, &any))? } else { pick(r, &any)? };
    if r.int(2) == 0 {
        // The owner flushes it, sometimes with every other matching card, sometimes with a second random one.
        let mut slots = 1u32 << slot;
        match r.int(4) {
            0 => {
                for &(p, s) in &matches {
                    if p == owner {
                        slots |= 1 << s;
                    }
                }
            }
            1 => slots |= 1 << pick(r, &occupied(g, owner))?,
            _ => {}
        }
        Some((owner, FlushOwn { slots }))
    } else {
        let seat = ((owner as usize + 1 + r.int(n as usize - 1)) % n as usize) as Seat;
        Some((seat, FlushOther { target: owner, slot }))
    }
}

/// A move that advances the round.
fn progress(g: &Cabo, r: &mut Rng) -> Option<(Seat, CaboAction)> {
    use CaboAction::*;
    if !g.transfers.is_empty() {
        let payers: Vec<Seat> = g.transfers.iter().map(|t| t.from).filter(|&p| g.live_count(p) > 0).collect();
        let seat = pick(r, &payers)?;
        return Some((seat, Transfer { slot: pick(r, &occupied(g, seat))? }));
    }
    let seat = g.turn;
    let others: Vec<Seat> = (0..g.n).filter(|&p| p != seat && g.live_count(p) > 0).collect();
    Some(match g.phase {
        Phase::InitialPeek => {
            let waiting: Vec<Seat> = (0..g.n).filter(|p| g.peeks_remaining >> p & 1 == 1).collect();
            let seat = pick(r, &waiting)?;
            let mut slots = occupied(g, seat);
            r.shuffle(&mut slots);
            let mask = slots.iter().take(g.rules.initial_peek_cards as usize).fold(0u32, |m, s| m | 1 << s);
            (seat, PeekStarting { slots: mask })
        }
        Phase::TurnDraw => (seat, Draw),
        Phase::DrawDecision => match pick(r, &occupied(g, seat)) {
            Some(slot) if r.int(2) == 0 => (seat, Keep { slot }),
            _ => (seat, DiscardDrawn),
        },
        Phase::PowerPending => {
            let own = pick(r, &occupied(g, seat));
            match g.pending_power?.0 {
                Power::PeekOwn => (seat, PeekOwn { slot: own? }),
                Power::PeekOther => {
                    let target = pick(r, &others)?;
                    (seat, PeekOther { target, slot: pick(r, &occupied(g, target))? })
                }
                Power::BlindSwap => {
                    let target = pick(r, &others)?;
                    (seat, BlindSwap { own: own?, target, slot: pick(r, &occupied(g, target))? })
                }
                Power::None => return None,
            }
        }
        Phase::TurnEnd => (seat, if r.int(12) == 0 { CallCabo } else { EndTurn }),
        Phase::Complete => return None,
    })
}

fn cabo_trace(games: u64, seed: u32) {
    let out = std::io::stdout();
    let mut out = std::io::BufWriter::new(out.lock());
    let mut r = Rng::new(seed);
    let (mut finished, mut steps_total, mut rejected) = (0u64, 0u64, 0u64);
    for game in 0..games {
        let players = 2 + r.int(5);
        let rules = random_rules(&mut r);
        let game_seed = r.next_u32();
        let mut g = match Cabo::deal(&rules, players, Rng::ts_compat(game_seed), false) {
            Ok(g) => g,
            Err(_) => continue,
        };
        let mut steps = Vec::new();
        for _ in 0..4000 {
            if g.phase == Phase::Complete {
                break;
            }
            let roll = r.int(100);
            let choice = if roll < 10 {
                Some(garbage(&g, &mut r))
            } else if roll < 22 {
                flush(&g, &mut r)
            } else {
                progress(&g, &mut r)
            };
            let (seat, action) = choice.unwrap_or_else(|| garbage(&g, &mut r));
            let ok = g.apply(seat, &action).is_ok();
            rejected += !ok as u64;
            steps.push(json!({ "seat": seat, "action": action, "ok": ok, "state": g.ts_snapshot() }));
        }
        finished += (g.phase == Phase::Complete) as u64;
        steps_total += steps.len() as u64;
        let line = json!({
            "game": game, "players": players, "seed": game_seed,
            "rules": rules.to_ts(), "steps": steps,
        });
        writeln!(out, "{line}").unwrap();
    }
    eprintln!("{games} games, {finished} finished, {steps_total} steps, {rejected} rejected");
}

// -------------------------------------------------------------------
// Simulation-mode playouts
// -------------------------------------------------------------------

/// The hand-written Cabo player against itself: how it calls and how fast it is.
fn cabo_bot(games: u64, players: usize) {
    let rules = CaboRules { turn_limit: 400, ..CaboRules::default() };
    let mut r = Rng::new(11);
    let (mut steps, mut calls, mut held, mut score) = (0u64, 0u64, 0u64, 0i64);
    let start = std::time::Instant::now();
    for _ in 0..games {
        let mut g = Cabo::deal(&rules, players, r.fork(), true).unwrap();
        while let Some(seat) = g.to_act() {
            let action = g.bot_action(&mut r).unwrap();
            g.apply(seat, &action).unwrap_or_else(|e| panic!("the bot's move was refused: {e} {action:?}"));
            steps += 1;
        }
        let result = g.result.as_ref().unwrap();
        score += result.scores.iter().map(|&s| s as i64).sum::<i64>();
        for e in &g.log {
            if let gamelab::games::cabo::CaboEvent::CaboCalled { seat, auto: false } = *e {
                calls += 1;
                held += result.winners.contains(&seat) as u64;
            }
        }
    }
    let secs = start.elapsed().as_secs_f64();
    println!(
        "{games} games, {players} players: {:.3} calls per seat, {:.3} of them won, mean score {:.2}, {:.1} decisions per game, {:.0} games/s",
        calls as f64 / (games * players as u64) as f64,
        held as f64 / calls.max(1) as f64,
        score as f64 / (games * players as u64) as f64,
        steps as f64 / games as f64,
        games as f64 / secs
    );
}

fn cabo_bench(games: u64, players: usize) {
    let rules = CaboRules { turn_limit: 400, ..CaboRules::default() };
    let mut r = Rng::new(7);
    let mut legal = Vec::new();
    let (mut steps, mut turns, mut wins) = (0u64, 0u64, vec![0f64; players]);
    let start = std::time::Instant::now();
    for _ in 0..games {
        let mut g = Cabo::deal(&rules, players, r.fork(), true).unwrap();
        while let Some(seat) = g.to_act() {
            g.legal_actions(&mut legal);
            assert!(!legal.is_empty(), "no legal action for seat {seat}: {g:?}");
            // Mostly pass on flush opportunities, as real players do.
            let action = if legal[0] == CaboAction::Pass && r.int(10) != 0 { legal[0] } else { legal[r.int(legal.len())] };
            g.apply(seat, &action).unwrap_or_else(|e| panic!("legal action refused: {e} {action:?}"));
            steps += 1;
        }
        turns += g.turns_started as u64;
        for &w in &g.result.as_ref().unwrap().winners {
            wins[w as usize] += 1.0 / g.result.as_ref().unwrap().winners.len() as f64;
        }
    }
    let secs = start.elapsed().as_secs_f64();
    println!(
        "{games} games, {players} players: {:.0} games/s, {:.2}M steps/s, {:.1} steps and {:.1} turns per game",
        games as f64 / secs,
        steps as f64 / secs / 1e6,
        steps as f64 / games as f64,
        turns as f64 / games as f64
    );
    println!("win share by seat: {:?}", wins.iter().map(|w| (w / games as f64 * 1000.0).round() / 1000.0).collect::<Vec<_>>());
}
