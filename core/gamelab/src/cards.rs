//! Playing cards shared by every game.
//!
//! A card is one physical card instance: `id = deck * 52 + suit * 13 + (rank - 1)`,
//! suits in the order spades, hearts, diamonds, clubs. The id is internal to the
//! core; what a seat may see of a card is decided by each game's view code.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Card(pub u8);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Suit {
    Spades,
    Hearts,
    Diamonds,
    Clubs,
}

pub const SUITS: [Suit; 4] = [Suit::Spades, Suit::Hearts, Suit::Diamonds, Suit::Clubs];

impl Card {
    pub fn new(suit: Suit, rank: u8) -> Card {
        debug_assert!((1..=13).contains(&rank));
        Card(suit as u8 * 13 + rank - 1)
    }

    /// 1 (ace) to 13 (king).
    #[inline]
    pub fn rank(self) -> u8 {
        self.0 % 13 + 1
    }

    #[inline]
    pub fn suit(self) -> Suit {
        SUITS[(self.0 / 13 % 4) as usize]
    }

    #[inline]
    pub fn is_red(self) -> bool {
        matches!(self.suit(), Suit::Hearts | Suit::Diamonds)
    }

    /// Suit and rank without the deck copy, `0..52`.
    #[inline]
    pub fn face(self) -> u8 {
        self.0 % 52
    }

    pub fn label(self) -> String {
        let rank = match self.rank() {
            1 => "A".to_string(),
            11 => "J".to_string(),
            12 => "Q".to_string(),
            13 => "K".to_string(),
            r => r.to_string(),
        };
        let suit = ['♠', '♥', '♦', '♣'][self.suit() as usize];
        format!("{rank}{suit}")
    }
}

/// `decks` standard 52-card decks in canonical order.
pub fn standard_deck(decks: u8) -> Vec<Card> {
    (0..decks as u16 * 52).map(|i| Card(i as u8)).collect()
}

/// A set of card instances (up to 128, i.e. two decks with room to spare).
///
/// Saved as the list of its cards, so a saved game is plain JSON that every
/// reader (JavaScript included) can hold exactly.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct CardSet(pub u128);

impl Serialize for CardSet {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.iter())
    }
}

impl<'de> Deserialize<'de> for CardSet {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let cards = Vec::<Card>::deserialize(d)?;
        if cards.iter().any(|c| c.0 >= 128) {
            return Err(serde::de::Error::custom("card out of range"));
        }
        Ok(cards.into_iter().collect())
    }
}

impl CardSet {
    pub const EMPTY: CardSet = CardSet(0);

    #[inline]
    pub fn has(self, c: Card) -> bool {
        self.0 >> c.0 & 1 == 1
    }
    #[inline]
    pub fn add(&mut self, c: Card) {
        self.0 |= 1u128 << c.0;
    }
    #[inline]
    pub fn remove(&mut self, c: Card) {
        self.0 &= !(1u128 << c.0);
    }
    #[inline]
    pub fn len(self) -> usize {
        self.0.count_ones() as usize
    }
    #[inline]
    pub fn is_empty(self) -> bool {
        self.0 == 0
    }
    pub fn iter(self) -> impl Iterator<Item = Card> {
        let mut bits = self.0;
        std::iter::from_fn(move || {
            if bits == 0 {
                return None;
            }
            let i = bits.trailing_zeros() as u8;
            bits &= bits - 1;
            Some(Card(i))
        })
    }
}

impl FromIterator<Card> for CardSet {
    fn from_iter<I: IntoIterator<Item = Card>>(iter: I) -> Self {
        let mut s = CardSet::EMPTY;
        for c in iter {
            s.add(c);
        }
        s
    }
}
