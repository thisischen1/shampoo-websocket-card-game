import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, parseCards } from '../src/shared/cards.js';
import {
  canPlayOn, sameRank, topOf, topRunLength, burnReason, extraTurnReason,
  activeZone, isOut, playableCards, bombCards, compareStartingHands,
} from '../src/shared/rules.js';

const pile = (s) => parseCards(s);
const top = (s) => topOf(pile(s));

test('empty pile accepts anything', () => {
  for (const r of ['3', '7', '10', 'K', 'A', '2']) {
    assert.equal(canPlayOn(r, null), true, r);
  }
});

test('equal or higher is allowed, lower is not', () => {
  assert.equal(canPlayOn('7', top('7D')), true, 'equal');
  assert.equal(canPlayOn('8', top('7D')), true, 'higher');
  assert.equal(canPlayOn('6', top('7D')), false, 'lower');
  assert.equal(canPlayOn('9', top('KD')), false);
  assert.equal(canPlayOn('A', top('KD')), true);
});

test('a 2 plays on anything and anything plays on a 2', () => {
  assert.equal(canPlayOn('2', top('AS')), true);
  assert.equal(canPlayOn('2', top('3S')), true);
  assert.equal(canPlayOn('2', top('2S')), true);
  assert.equal(canPlayOn('A', top('2S')), true);
  assert.equal(canPlayOn('3', top('2S')), true, 'lowest card plays on a 2');
});

test('a 10 plays on anything', () => {
  assert.equal(canPlayOn('10', top('AS')), true);
  assert.equal(canPlayOn('10', top('2S')), true);
  assert.equal(canPlayOn('10', null), true);
});

test('sameRank', () => {
  assert.equal(sameRank(parseCards('7H 7S 7D')), true);
  assert.equal(sameRank(parseCards('7H 8S')), false);
  assert.equal(sameRank(parseCards('7H')), true);
  assert.equal(sameRank([]), false);
});

test('topRunLength counts consecutive matching ranks from the top', () => {
  assert.equal(topRunLength(pile('')), 0);
  assert.equal(topRunLength(pile('5H')), 1);
  assert.equal(topRunLength(pile('5H 7D 7S')), 2);
  assert.equal(topRunLength(pile('7D 7S 7C 7H')), 4);
  assert.equal(topRunLength(pile('7D 7S 7C 8H')), 1, 'broken run');
});

test('a 10 burns; four of a kind burns; near-misses do not', () => {
  assert.equal(burnReason(pile('5H 10D'), '10'), 'ten');
  assert.equal(burnReason(pile('7D 7S 7C 7H'), '7'), 'fourOfAKind');
  assert.equal(burnReason(pile('9C 7D 7S 7C 7H'), '7'), 'fourOfAKind', 'four on top of junk');
  assert.equal(burnReason(pile('7D 7S 7C'), '7'), null, 'only three');
  assert.equal(burnReason(pile('7D 7S 7C 8H'), '8'), null, '7,7,7,8 does not burn');
  assert.equal(burnReason(pile('5H 6D'), '6'), null);
});

test('four 2s burn — twos are not exempt', () => {
  assert.equal(burnReason(pile('2H 2S 2D 2C'), '2'), 'fourOfAKind');
});

test('extra turn: a 2 grants one without burning, a 10 and a bomb grant one with', () => {
  // a 2 on a king: extra turn, but no burn
  assert.equal(burnReason(pile('KD 2H'), '2'), null);
  assert.equal(extraTurnReason('2', null), 'two');

  assert.equal(extraTurnReason('10', 'ten'), 'ten');
  assert.equal(extraTurnReason('7', 'fourOfAKind'), 'fourOfAKind');

  // an ordinary card grants nothing
  assert.equal(extraTurnReason('7', null), null);
  assert.equal(extraTurnReason('A', null), null);
});

test('four 2s burn and still grant exactly one extra turn', () => {
  const reason = burnReason(pile('2H 2S 2D 2C'), '2');
  assert.equal(reason, 'fourOfAKind');
  assert.equal(extraTurnReason('2', reason), 'fourOfAKind');
});

test('activeZone prefers hand, then face-up, then face-down', () => {
  const p = (hand, faceUp, faceDown) => ({
    hand: parseCards(hand), faceUp: parseCards(faceUp), faceDown: parseCards(faceDown),
  });
  assert.equal(activeZone(p('3H', 'KS', 'AD')), 'hand');
  assert.equal(activeZone(p('', 'KS', 'AD')), 'faceUp');
  assert.equal(activeZone(p('', '', 'AD')), 'faceDown');
  assert.equal(activeZone(p('', '', '')), null);
  assert.equal(isOut(p('', '', '')), true);
  assert.equal(isOut(p('', '', 'AD')), false);
});

test('playableCards filters by the top card', () => {
  const ids = playableCards(parseCards('3H 9S 10D 2C KH'), top('9H')).map((c) => c.id);
  assert.deepEqual(ids, ['9S', '10D', '2C', 'KH']);
});

test('bombCards flags a card that would complete four of a kind', () => {
  // three 7s showing, you hold one 7
  let hot = bombCards(parseCards('7H 9S'), pile('7D 7S 7C'));
  assert.deepEqual(hot.map((c) => c.id), ['7H']);

  // two 7s showing, you hold two 7s
  hot = bombCards(parseCards('7H 7S 9D'), pile('7D 7C'));
  assert.deepEqual(hot.map((c) => c.id).sort(), ['7H', '7S']);

  // one 7 showing, you hold two -> only three total, not hot
  hot = bombCards(parseCards('7H 7S'), pile('7D'));
  assert.deepEqual(hot, []);

  // you hold all four of a rank -> hot on any pile you can play on
  hot = bombCards(parseCards('KH KS KD KC'), pile('5H'));
  assert.equal(hot.length, 4);
});

test('bombCards ignores cards that are not legally playable', () => {
  // you hold three 5s and a 5 is nowhere near the top; pile top is an ace
  const hot = bombCards(parseCards('5H 5S 5D 5C'), pile('AS'));
  assert.deepEqual(hot, [], 'cannot play a 5 on an ace, so it is not hot');
});

test('bombCards does not count a broken run on the pile', () => {
  // 7,7,7 then an 8 landed on top: the 7 run is dead
  const hot = bombCards(parseCards('7H'), pile('7D 7S 7C 8H'));
  assert.deepEqual(hot, [], 'run was broken by the 8');
});

test('compareStartingHands: lowest card starts, ties break on the next card', () => {
  const h = (s) => parseCards(s);
  assert.ok(compareStartingHands(h('3H 9S KD'), h('4H 5S 6D')) < 0, '3 beats 4');
  assert.ok(compareStartingHands(h('5H 7S 9D'), h('5C 6S 8D')) > 0, 'tie on 5, 6 beats 7');
  assert.ok(compareStartingHands(h('5H 6S 9D'), h('5C 6D 10H')) < 0, 'tie twice, 9 beats 10');
  assert.equal(compareStartingHands(h('5H 6S 9D'), h('5C 6D 9H')), 0, 'identical ranks tie');
});

test('compareStartingHands treats a 2 as high, so a hand of 2s goes last', () => {
  const h = (s) => parseCards(s);
  assert.ok(compareStartingHands(h('2H 2S 2D'), h('AH AS AD')) > 0);
  assert.ok(compareStartingHands(h('3H 2S 2D'), h('4H 4S 4D')) < 0);
});
