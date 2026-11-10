//! What a seat sees, in the form the model reads.
//!
//! Every game describes a position as a set of *tokens* (the table, each
//! player, each card, recent events, the rules in force) and each legal action
//! as a verb with pointers to the tokens it acts on. The layout is the same
//! for all games, so one network can play all of them and a new game needs no
//! new network code.
//!
//! A token is `FIELDS` small non-negative integers. Field meanings are shared
//! across games wherever the concept is shared (seat, rank, suit, points), so
//! what the model learns about them carries over. Seats are always relative to
//! the observer: 1 is the observer, 2 the next seat clockwise, 0 "nobody".

use crate::cards::Card;
use crate::game::Seat;

pub const FIELDS: usize = 10;

/// Field positions inside a token.
pub mod field {
    /// One of the `kind` constants.
    pub const KIND: usize = 0;
    /// Meaning depends on the kind: zone of a card, type of an event, which
    /// rule, which game (global token).
    pub const SUB: usize = 1;
    /// Relative seat that owns the card / performed the event / is to move.
    pub const SEAT: usize = 2;
    /// Position in a hand or on the table, plus one (0 = none).
    pub const SLOT: usize = 3;
    /// 1 to 13, or 0 when hidden or not applicable.
    pub const RANK: usize = 4;
    /// 1 to 4 (spades, hearts, diamonds, clubs), or 0.
    pub const SUIT: usize = 5;
    /// A number such as points or a count, stored as `value + VALUE_ZERO`
    /// and clamped; 0 means "none".
    pub const VALUE: usize = 6;
    /// Bit flags; for cards, bit `i` set when relative seat `i + 1` knows it.
    pub const FLAGS: usize = 7;
    /// A second relative seat (target of an event).
    pub const SEAT2: usize = 8;
    /// A second small number (age of an event, power of a card, a count).
    pub const AUX: usize = 9;
}

/// Exclusive upper bound of each field; the model sizes its tables from this.
pub const FIELD_SIZE: [u16; FIELDS] = [8, 1024, 8, 64, 14, 5, 96, 256, 8, 96];

/// `VALUE` holds `value + VALUE_ZERO`, so values from -31 to 63 fit.
pub const VALUE_ZERO: i32 = 32;

pub mod kind {
    pub const GLOBAL: u16 = 1;
    pub const PLAYER: u16 = 2;
    pub const CARD: u16 = 3;
    pub const EVENT: u16 = 4;
    pub const RULE: u16 = 5;
    /// A summary of a pile, e.g. how many cards of a rank were discarded.
    pub const PILE: u16 = 6;
}

/// Card zones, shared by all games.
pub mod zone {
    pub const HAND: u16 = 1;
    pub const DRAWN: u16 = 2;
    pub const DISCARD_TOP: u16 = 3;
    pub const DISCARD: u16 = 4;
    pub const TABLE: u16 = 5;
    pub const CAPTURED: u16 = 6;
    pub const DECK: u16 = 7;
}

/// Each game owns a block of `SUB` values and of action verbs.
pub const GAME_BLOCK: u16 = 64;

/// `SUB` value or verb number `local` of game number `game`.
pub const fn game_code(game: u16, local: u16) -> u16 {
    game * GAME_BLOCK + local
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Token(pub [u16; FIELDS]);

impl Token {
    pub fn new(kind: u16, sub: u16) -> Token {
        let mut t = Token::default();
        t.0[field::KIND] = kind;
        t.0[field::SUB] = sub;
        t
    }
    pub fn seat(mut self, rel: u16) -> Self {
        self.0[field::SEAT] = rel;
        self
    }
    pub fn seat2(mut self, rel: u16) -> Self {
        self.0[field::SEAT2] = rel;
        self
    }
    pub fn slot(mut self, slot: usize) -> Self {
        self.0[field::SLOT] = (slot as u16 + 1).min(FIELD_SIZE[field::SLOT] - 1);
        self
    }
    /// Show the card's face.
    pub fn face(mut self, card: Card) -> Self {
        self.0[field::RANK] = card.rank() as u16;
        self.0[field::SUIT] = card.suit() as u16 + 1;
        self
    }
    pub fn rank(mut self, rank: u8) -> Self {
        self.0[field::RANK] = rank as u16;
        self
    }
    pub fn suit(mut self, suit: u16) -> Self {
        self.0[field::SUIT] = suit;
        self
    }
    pub fn value(mut self, v: i32) -> Self {
        self.0[field::VALUE] = (v + VALUE_ZERO).clamp(1, FIELD_SIZE[field::VALUE] as i32 - 1) as u16;
        self
    }
    pub fn flags(mut self, f: u16) -> Self {
        self.0[field::FLAGS] = f & (FIELD_SIZE[field::FLAGS] - 1);
        self
    }
    pub fn aux(mut self, v: usize) -> Self {
        self.0[field::AUX] = (v as u16).min(FIELD_SIZE[field::AUX] - 1);
        self
    }
}

/// No token: an unused action argument.
pub const NO_ARG: u16 = u16::MAX;

/// A legal action as the model sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ActionToken {
    /// `game_code(game, local verb)`.
    pub verb: u16,
    /// Indices into `Obs::tokens` of the things acted on, or `NO_ARG`.
    pub args: [u16; 3],
    /// A small number for verbs that need one (e.g. a count), below 64.
    pub param: u16,
}

impl ActionToken {
    pub fn new(verb: u16) -> ActionToken {
        ActionToken { verb, args: [NO_ARG; 3], param: 0 }
    }
    pub fn arg(mut self, i: usize, token: usize) -> Self {
        self.args[i] = token as u16;
        self
    }
    pub fn param(mut self, p: usize) -> Self {
        self.param = (p as u16).min(63);
        self
    }
}

/// One seat's observation. `actions[i]` describes the i-th entry of
/// `Game::legal_actions` when the observer is the seat to move, and is empty
/// otherwise.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Obs {
    pub tokens: Vec<Token>,
    pub actions: Vec<ActionToken>,
}

impl Obs {
    pub fn clear(&mut self) {
        self.tokens.clear();
        self.actions.clear();
    }

    /// Add a token and return its index.
    pub fn push(&mut self, t: Token) -> usize {
        debug_assert!(
            t.0.iter().zip(FIELD_SIZE).all(|(&v, max)| v < max),
            "token field out of range: {t:?}"
        );
        self.tokens.push(t);
        self.tokens.len() - 1
    }
}

/// Seat `seat` as seen from `me` at a table of `n`: 1 for `me`, 2 for the
/// next seat clockwise, and so on.
pub fn rel(me: Seat, seat: Seat, n: u8) -> u16 {
    ((seat + n - me) % n) as u16 + 1
}

/// A set of absolute seats (bit per seat) as relative-seat flags.
pub fn rel_mask(me: Seat, seats: u8, n: u8) -> u16 {
    (0..n).filter(|p| seats >> p & 1 == 1).fold(0, |m, p| m | 1 << (rel(me, p, n) - 1))
}
