import test from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../src/game/engine.js';
import { makeState, act, rejects, ids, findEvent, turnEvent } from './helpers.js';

const base = () => makeState({
  hands: ['7H 9S KD', '4C 5C 6C'],
  faceUp: ['AH AS AD', '3S 3D 3C'],
  faceDown: ['QH QS QD', '8H 8S 8D'],
  pile: '5H',
  stock: 'JH JS JD JC',
  current: 0,
});

test('a legal single-card play lands on the pile and passes the turn', () => {
  const s = base();
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['7H'], turnSeq: 1 });
  assert.deepEqual(ids(s.pile), ['5H', '7H']);
  assert.equal(s.current, 1);
  assert.equal(findEvent(res, 'played').zone, 'hand');
});

test('playing lower than the top card is rejected', () => {
  const s = makeState({
    hands: ['4H 9S KD', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3S 3D 3C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '9H',
    current: 0,
  });
  rejects(s, { type: 'PLAY', seat: 0, cardIds: ['4H'], turnSeq: 1 }, ERR.TOO_LOW);
});

test('equal rank is allowed', () => {
  const s = makeState({
    hands: ['9H 3S 4D', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 3C 5S'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '9D',
    current: 0,
  });
  act(s, { type: 'PLAY', seat: 0, cardIds: ['9H'], turnSeq: 1 });
  assert.deepEqual(ids(s.pile), ['9D', '9H']);
});

test('multiple cards of the same rank can be played, and partial sets are allowed', () => {
  const s = makeState({
    hands: ['7H 7S 7D', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3S 3D 3C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '5H',
    stock: 'JH JS JD JC',
    current: 0,
  });
  act(s, { type: 'PLAY', seat: 0, cardIds: ['7H', '7S'], turnSeq: 1 });
  assert.deepEqual(ids(s.pile), ['5H', '7H', '7S']);
  assert.equal(s.players[0].hand.filter((c) => c.rank === '7').length, 1, 'kept one back');
});

test('mixed ranks, duplicates, empty plays and oversized plays are all rejected', () => {
  const s = base();
  rejects(s, { type: 'PLAY', seat: 0, cardIds: ['7H', '9S'], turnSeq: 1 }, ERR.MIXED_RANKS);
  rejects(s, { type: 'PLAY', seat: 0, cardIds: ['7H', '7H'], turnSeq: 1 }, ERR.DUPLICATE_CARDS);
  rejects(s, { type: 'PLAY', seat: 0, cardIds: [], turnSeq: 1 }, ERR.NO_CARDS);
  rejects(
    s,
    { type: 'PLAY', seat: 0, cardIds: ['7H', '7S', '7D', '7C', '9S'], turnSeq: 1 },
    ERR.TOO_MANY_CARDS,
  );
});

test('you cannot play a card you do not hold, or one from another seat', () => {
  const s = base();
  rejects(s, { type: 'PLAY', seat: 0, cardIds: ['2C'], turnSeq: 1 }, ERR.CARD_NOT_IN_ZONE);
  rejects(s, { type: 'PLAY', seat: 0, cardIds: ['4C'], turnSeq: 1 }, ERR.CARD_NOT_IN_ZONE);
});

test('face-up cards are locked while you still hold hand cards', () => {
  const s = base();
  rejects(s, { type: 'PLAY', seat: 0, cardIds: ['AH'], turnSeq: 1 }, ERR.CARD_NOT_IN_ZONE);
});

test('acting out of turn is rejected', () => {
  const s = base();
  rejects(s, { type: 'PLAY', seat: 1, cardIds: ['6C'], turnSeq: 1 }, ERR.NOT_YOUR_TURN);
});

test('a stale turnSeq is rejected, which kills the double-tap double-play', () => {
  const s = base();
  act(s, { type: 'PLAY', seat: 0, cardIds: ['7H'], turnSeq: 1 });
  // the same frame arriving twice
  rejects(s, { type: 'PLAY', seat: 0, cardIds: ['9S'], turnSeq: 1 }, ERR.STALE);
});

test('anything may be played onto an empty pile', () => {
  const s = makeState({
    hands: ['3H 9S KD', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3S 3D 3C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '',
    stock: 'JH JS JD JC',
    current: 0,
  });
  act(s, { type: 'PLAY', seat: 0, cardIds: ['3H'], turnSeq: 1 });
  assert.deepEqual(ids(s.pile), ['3H']);
});

test('face-up cards become playable once the hand and stock are empty', () => {
  const s = makeState({
    hands: ['', '4C 5C 6C'],
    faceUp: ['AH 7S 7D', '3S 3D 3C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '5H',
    stock: '',
    current: 0,
  });
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['7S', '7D'], turnSeq: 1 });
  assert.equal(findEvent(res, 'played').zone, 'faceUp');
  assert.deepEqual(ids(s.pile), ['5H', '7S', '7D']);
  assert.equal(findEvent(res, 'drew'), undefined, 'no draw with an empty stock');
});

test('while only face-down cards remain, PLAY is refused in favour of a flip', () => {
  const s = makeState({
    hands: ['', '4C 5C 6C'],
    faceUp: ['', '3S 3D 3C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '5H',
    stock: '',
    current: 0,
  });
  rejects(s, { type: 'PLAY', seat: 0, cardIds: ['QH'], turnSeq: 1 }, ERR.MUST_FLIP);
});

test('a 2 plays on anything and anything plays back onto the 2', () => {
  const s = makeState({
    hands: ['2H 3S 9D', '3C 4C 5C'],
    faceUp: ['AH AS AD', '3D 6C 7C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: 'AC',
    stock: 'JH JS JD JC',
    current: 0,
  });
  act(s, { type: 'PLAY', seat: 0, cardIds: ['2H'], turnSeq: 1 });
  assert.equal(s.current, 0, 'a 2 keeps the turn');
  // the 2 is on top, so the lowest card in the deck is now legal
  act(s, { type: 'PLAY', seat: 0, cardIds: ['3S'], turnSeq: s.turnSeq });
  assert.deepEqual(ids(s.pile), ['AC', '2H', '3S']);
});
