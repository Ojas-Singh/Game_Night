# Seep — Punjabi 100-point rules (canonical contract)

Source of truth: [Pagat — Seep](https://www.pagat.com/fishing/seep.html) (John McLeod, based on
Ankit Bhageria). This document is the **contract** for `packages/engine-seep`. Implementation and
tests must match it line by line. Where this file and code disagree, this file wins.

## Players, seating, order

- 4 players, fixed partnerships, partners opposite (seats N/E/S/W; teams by seat parity:
  N+S vs E+W — teams are logical, never re-seated).
- Deal and play are **counter-clockwise**. In seat indices (0=N, 1=E, 2=S, 3=W) the play order is
  `seat → seat-1 mod 4` (N→W→S→E). Pagat's examples confirm: North deals ⇒ West is next.
- "The player to X's right" = the next player in this counter-clockwise order.

## Objective and card values

- Capture-value: A=1 … 10=10, J=11, Q=12, K=13 (suit irrelevant for capture).
- Scoring cards (only these 17 carry points): **every spade = capture value (A♠ 1 … K♠ 13)**,
  **non-spade aces = 1**, **10♦ = 6**. Total = **100 points**. No majority-of-cards bonus.
- Sweeps (seep): clearing the whole floor with one play = **+50**; on the **very first play of the
  deal** = **+25**; on the **very last play** = **0**.
- The sweep card is stored face up in the team's pile as a sweep marker (count stays visible).

## Deal, bid and opening

1. First dealer chosen at random. The dealer gives **4 cards to the player to his right (the
   bidder)** and places **4 cards face down** on the floor.
2. The bidder must **bid 9–13**, matching the capture value of a card in hand. If impossible
   (no card above 8): cards are thrown in and the deal is **repeated** (same dealer, new shuffle)
   — no penalty, repeat until a bid exists.
3. The floor cards turn face up. The bidder's **first play** must be one of:
   - **create a house of the bid value** (played card + floor card(s) summing to the bid — the
     played card itself need not equal the bid);
   - **play a card of the bid value** as a capture (taking everything it must take);
   - **throw a card of the bid value** loose (only if nothing can be captured/established with it).
4. The dealer then deals the rest counter-clockwise **in packets of four**, starting at the
   bidder. Bidder ends with 11 cards, everyone else 12. Everyone plays all their cards:
   **48 plays per deal** (every player plays 12 cards — the bidder's 4
   opening cards include the first play; 4 + 4 + 8 + 36 = 52 exactly).

## Turn structure

One card per turn. The card may be used to: establish a house, cement/add to a house, break a
kachcha house, capture, or be thrown loose. **Throwing is illegal only if the played card itself
could capture something** (a loose card, set, or house matching its value). Using the card inside
a house (build/cement/break) is always a legal alternative use — there is **no** requirement to
choose a capturing card from the hand.

## Houses (ghar)

- A house is 2+ floor cards totalling its capture value; allowed values **9–13** only.
- **One house per value** — a second house of the same value cannot exist; plays that would make
  one merge into a **cemented** house. A loose card of value V and a V-house also cannot coexist:
  - loose card first ⇒ it is **automatically cemented into** the new house;
  - house first ⇒ a played V-card must either cement or pick up the house.
- `copies(house) = Σ captureValue(cards) / total`; **cemented (pakka) = copies ≥ 2**.
- **Ownership**: every house has ≥ 1 owner. Establisher owns it; a break transfers ownership to
  the breaker; an **opponent who cements/adds becomes a second owner** (both teams may own one
  house). An owner must **keep a card of the house's value in hand** until the house is picked up
  or broken. A partner who adds to their partner's house does **not** become an owner.
- Only **house contents are always inspectable**. Captured piles are face down (see Information).

### Establishing

Played card + one or more loose cards = total T (9–13), and the player holds another T (retention).
You can only establish **for yourself** (never for a partner). Auto-cement: if, after creating a
T-house, a loose card of value T — or a set of loose cards summing to T — remains on the floor, it
is **automatically added**, cementing the house (same for a played card equal to a loose card:
9 on a loose 9 = cemented 9-house).

### Cementing (making pakka)

1. Play a card equal to the house's value onto an ordinary house.
2. Play a card that with loose card(s) sums to the house's value; those cards join the house.
3. Break another player's ordinary house so its new value equals an existing house's value; the
   two combine. If the combined house is owned by an opponent and you don't hold the value, this
   is legal only when your **partner** owns the target (they stay owner and retain).
   While cementing, any loose cards matching or summing to the value may also be absorbed.
   Cementing/addition to a house owned (in whole) by the opponent makes the cemerter a **second
   owner** with retention duty.

### Adding to a cemented house

Further complete sets (same three methods) may be added; one card of each added set must come
from the hand. Opponent adders need retention and become second owners; partner adders don't.

### Breaking

An **ordinary** (kachcha) house belonging to **another player** (partner or opponent — never your
own) is broken by adding **one card from hand** (never floor cards, never card+floor-card)
increasing its value to a new total ≤ 13. The breaker must hold a card of the new value and
**becomes the owner** (the previous owner's obligation ends). If the resulting value matches an
existing house or loose card(s) on the floor, they combine/auto-cement into a pakka house.
Cemented houses can never be broken.

## Picking up (capturing)

- A single loose card is taken by an equal card; a set of loose cards by a card equal to their sum.
- A house (ordinary or cemented) is taken **only** by a card of its exact value — never as part
  of a set.
- **All matching items must be taken together**: every house of the played value plus loose
  cards/sets. Loose sets taken simultaneously **cannot overlap**: J over floor `2,3,5,6` gives
  exactly two legal choices — `2+3+6` or `5+6` — the remainder stays.
- The compulsion applies when the played card is **not used in a house**: you cannot leave any
  loose card, set, or house that your played card could take (Pagat's 7-8-8-J example: the J
  *must* take 2+9 and the loose J, leaving only the K).

## End of play, scoring, baazi

- Play ends after 48 plays. All houses are necessarily gone (retention guarantees their owners
  held and eventually played matching cards). **Remaining loose cards go to the team that made
  the last pick-up** (if nobody ever picked up, they score nothing).
- Team deal score = spades + non-spade aces + 10♦ (6) + sweep bonuses.
- **Baazi**: only the **signed difference** of each deal accumulates. When a team's lead reaches
  **+100**, it wins the baazi and the difference resets to 0.
- **9-point minimum**: if a team scores **fewer than 9 points** in a deal, it **immediately loses
  the baazi** regardless of the running score; difference resets to 0.
- **Dealer progression**:
  - If the team that dealt the last hand is **behind or level** ⇒ the **same dealer deals again**.
  - If the dealing team is **winning** ⇒ the deal passes to the next player to the right (who is
    on the losing team).
  - **After a baazi** ⇒ the next dealer is the **partner** of the player who would have dealt
    next without the baazi.

## Information model

- Floor cards and house contents: face up, always inspectable.
- Captured cards: stored face down. A team's latest pick-up may be inspected **until the next
  player has played**; after that, no captured card is inspectable by anyone until the score
  count at deal end.
- Test Mode (host) reveals everything, as a dev aid only.

## Named preset deviations (kept out of the default)

- `CASUAL_TEND_TWO`: 10♦ = 2, +4 for majority of cards, no first-play 25 distinction — the old
  house mix, retained only as an explicit variant.
- 30-point Punjab Seep: a different game (7 scoring cards, sweep = played card's value, 10♦/9♠
  floor-check on deal). Out of scope; would be its own preset.
- "Limited houses" (max 2 on the floor) and two-player Seep: out of scope.
