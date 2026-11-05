// Pure game rules. Isomorphic: imported by the server engine and by the browser
// (via the /shared/ static mount) so the two can never disagree.

import { POWER, WILD_RANK, BURN_RANK } from './cards.js';

export const BOMB_SIZE = 4;
export const HAND_SIZE = 3;
export const MAX_PLAY = 4; // can't play more than four of a rank from one deck

export function topOf(pile) {
  return pile.length ? pile[pile.length - 1] : null;
}

/**
 * May a card of `rank` be played onto `top`?
 *   - empty pile: anything
 *   - 2 is wild: plays on anything, and anything plays on a 2
 *   - 10 always plays (and burns)
 *   - otherwise equal-or-higher
 */
export function canPlayOn(rank, top) {
  if (top === null || top === undefined) return true;
  if (rank === WILD_RANK) return true;
  if (rank === BURN_RANK) return true;
  if (top.rank === WILD_RANK) return true;
  return POWER[rank] >= POWER[top.rank];
}

export function sameRank(cards) {
  return cards.length > 0 && cards.every((c) => c.rank === cards[0].rank);
}

/** How many cards on top of the pile share the top card's rank. */
export function topRunLength(pile) {
  if (!pile.length) return 0;
  const rank = pile[pile.length - 1].rank;
  let n = 0;
  for (let i = pile.length - 1; i >= 0 && pile[i].rank === rank; i--) n++;
  return n;
}

/**
 * Does the pile burn? Call with the pile *after* the cards have been pushed.
 * One predicate covers both bomb routes — four at once and four accumulated
 * across turns — because the resulting top four are identical either way.
 */
export function burnReason(pile, playedRank) {
  if (playedRank === BURN_RANK) return 'ten';
  if (topRunLength(pile) >= BOMB_SIZE) return 'fourOfAKind';
  return null;
}

/**
 * Does the same player play again? Deliberately separate from burning:
 * a 2 grants another turn *without* destroying the pile.
 */
export function extraTurnReason(playedRank, burned) {
  if (burned === 'ten') return 'ten';
  if (burned === 'fourOfAKind') return 'fourOfAKind';
  if (playedRank === WILD_RANK) return 'two';
  return null;
}

/**
 * Which pile of cards the player must play from this turn.
 * Hand cards lock the table cards; face-down is blind-flip only.
 */
export function activeZone(player) {
  if (player.hand.length > 0) return 'hand';
  if (player.faceUp.length > 0) return 'faceUp';
  if (player.faceDown.length > 0) return 'faceDown';
  return null;
}

export function isOut(player) {
  return activeZone(player) === null;
}

/** Cards in `zone` that are legal to play right now. */
export function playableCards(cards, top) {
  return cards.filter((c) => canPlayOn(c.rank, top));
}

/**
 * Cards the player holds that could complete a four-of-a-kind this turn.
 * Drives the private "bomb" glow — the client is told which of *its own* cards
 * are hot without ever learning the pile's composition.
 */
export function bombCards(cards, pile) {
  const top = topOf(pile);
  const run = topRunLength(pile);
  const runRank = run > 0 ? pile[pile.length - 1].rank : null;

  const byRank = new Map();
  for (const c of cards) {
    if (!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank).push(c);
  }

  const hot = [];
  for (const [rank, group] of byRank) {
    const onPile = rank === runRank ? run : 0;
    if (onPile + group.length < BOMB_SIZE) continue;
    if (!canPlayOn(rank, top)) continue;
    hot.push(...group);
  }
  return hot;
}

/**
 * Compare two players' hands for "who starts": lowest card wins, ties broken by
 * the next-lowest, and so on. Returns <0 if `a` starts before `b`.
 * A 2 counts as high (POWER 15), so a 3 is the lowest card in the deck.
 */
export function compareStartingHands(a, b) {
  const as = [...a].map((c) => POWER[c.rank]).sort((x, y) => x - y);
  const bs = [...b].map((c) => POWER[c.rank]).sort((x, y) => x - y);
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    if (as[i] !== bs[i]) return as[i] - bs[i];
  }
  return as.length - bs.length;
}
