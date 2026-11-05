// Pure, isomorphic card primitives. Imported by both the server and the browser.

export const SUITS = ['S', 'H', 'D', 'C'];
export const SUIT_GLYPH = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };
export const SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };

// Deal/display order, low to high. A 2 sorts highest here; it is *playable* on
// anything via canPlayOn, but for "lowest card" comparisons it counts as high.
export const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];

export const POWER = Object.freeze(
  RANKS.reduce((acc, rank, i) => {
    acc[rank] = i + 3; // 3 -> 3 ... A -> 14, 2 -> 15
    return acc;
  }, {}),
);

export const WILD_RANK = '2';
export const BURN_RANK = '10';

export function isRed(card) {
  return card.suit === 'H' || card.suit === 'D';
}

export function cardId(rank, suit) {
  return `${rank}${suit}`;
}

/** Build a card object. Throws on an unknown rank/suit so typos fail loudly. */
export function makeCard(rank, suit) {
  if (!POWER[rank]) throw new Error(`bad rank: ${rank}`);
  if (!SUITS.includes(suit)) throw new Error(`bad suit: ${suit}`);
  return { id: cardId(rank, suit), rank, suit };
}

/** Parse "10D" / "7h" / "AS" into a card. */
export function parseCard(str) {
  const s = String(str).trim();
  const suit = s.slice(-1).toUpperCase();
  const rank = s.slice(0, -1).toUpperCase();
  return makeCard(rank, suit);
}

/** Parse a whitespace-separated list: "7H 7S 10D" -> Card[]. */
export function parseCards(str) {
  if (!str) return [];
  return String(str).trim().split(/\s+/).filter(Boolean).map(parseCard);
}

/** A fresh, ordered 52-card deck. */
export function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(makeCard(rank, suit));
  }
  return deck;
}

export function label(card) {
  return `${card.rank}${SUIT_GLYPH[card.suit]}`;
}

export function labelAll(cards) {
  return cards.map(label).join(' ');
}

/** Sort a copy ascending by power, then by suit for a stable display order. */
export function sortCards(cards) {
  return [...cards].sort(
    (a, b) => POWER[a.rank] - POWER[b.rank] || SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit),
  );
}
