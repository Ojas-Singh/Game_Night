//! Game Night rules core.
//!
//! Every card game is written once here. The same code runs the live site
//! (compiled to WebAssembly), self-play and search (native), so the model
//! always trains on exactly the game people play.

pub mod cards;
pub mod check;
pub mod dynamic;
pub mod exact;
pub mod game;
pub mod games;
pub mod obs;
pub mod rng;
pub mod search;
pub mod settings;
pub mod vecenv;

pub use cards::{Card, CardSet, Suit};
pub use game::{AtTable, Game, Illegal, Seat};
pub use obs::Obs;
pub use rng::Rng;
pub use settings::Setting;
