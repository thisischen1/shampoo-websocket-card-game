import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RANKS, SUITS, POWER, makeDeck, makeCard, parseCard, parseCards,
  isRed, label, sortCards,
} from '../src/shared/cards.js';
import { mulberry32, shuffle } from '../src/game/rng.js';

test('deck has 52 unique cards', () => {
  const deck = makeDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map((c) => c.id)).size, 52);
});

test('rank ordering puts 3 lowest and 2 highest', () => {
  assert.equal(RANKS[0], '3');
  assert.equal(RANKS[RANKS.length - 1], '2');
  assert.equal(POWER['3'], 3);
  assert.equal(POWER['10'], 10);
  assert.equal(POWER['J'], 11);
  assert.equal(POWER['A'], 14);
  assert.equal(POWER['2'], 15);
  assert.ok(POWER['2'] > POWER['A']);
});

test('every rank and suit appears exactly four / thirteen times', () => {
  const deck = makeDeck();
  for (const r of RANKS) {
    assert.equal(deck.filter((c) => c.rank === r).length, 4, `rank ${r}`);
  }
  for (const s of SUITS) {
    assert.equal(deck.filter((c) => c.suit === s).length, 13, `suit ${s}`);
  }
});

test('parseCard handles two-character ranks and mixed case', () => {
  assert.deepEqual(parseCard('10D'), { id: '10D', rank: '10', suit: 'D' });
  assert.deepEqual(parseCard('7h'), { id: '7H', rank: '7', suit: 'H' });
  assert.deepEqual(parseCard('as'), { id: 'AS', rank: 'A', suit: 'S' });
  assert.deepEqual(parseCard(' 2C '), { id: '2C', rank: '2', suit: 'C' });
});

test('parseCards splits a list and tolerates empty input', () => {
  assert.deepEqual(parseCards('7H 7S 10D').map((c) => c.id), ['7H', '7S', '10D']);
  assert.deepEqual(parseCards(''), []);
  assert.deepEqual(parseCards('   '), []);
});

test('bad rank or suit throws rather than producing a junk card', () => {
  assert.throws(() => makeCard('1', 'S'));
  assert.throws(() => makeCard('K', 'X'));
  assert.throws(() => parseCard('ZZ'));
});

test('isRed and label', () => {
  assert.equal(isRed(parseCard('AH')), true);
  assert.equal(isRed(parseCard('AD')), true);
  assert.equal(isRed(parseCard('AS')), false);
  assert.equal(label(parseCard('10S')), '10\u2660');
});

test('sortCards is ascending by power and does not mutate', () => {
  const cards = parseCards('2H 3S KD 10C');
  const sorted = sortCards(cards);
  assert.deepEqual(sorted.map((c) => c.rank), ['3', '10', 'K', '2']);
  assert.deepEqual(cards.map((c) => c.id), ['2H', '3S', 'KD', '10C']);
});

test('same seed produces the same shuffle, different seeds do not', () => {
  const deck = makeDeck();
  const a = shuffle(deck, mulberry32(12345)).map((c) => c.id);
  const b = shuffle(deck, mulberry32(12345)).map((c) => c.id);
  const c = shuffle(deck, mulberry32(999)).map((c) => c.id);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('shuffle preserves the full deck and leaves the input untouched', () => {
  const deck = makeDeck();
  const before = deck.map((c) => c.id);
  const out = shuffle(deck, mulberry32(7));
  assert.equal(out.length, 52);
  assert.deepEqual(new Set(out.map((c) => c.id)).size, 52);
  assert.deepEqual(deck.map((c) => c.id), before);
});
