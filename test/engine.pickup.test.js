import test from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../src/game/engine.js';
import { activeZone } from '../src/shared/rules.js';
import { makeState, act, rejects, ids, findEvent } from './helpers.js';

test('picking up moves the whole pile into hand in bottom-to-top order', () => {
  const s = makeState({
    hands: ['9S KD 4H', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '5H 6H 7H',
    stock: 'JH JS JD',
    current: 0,
  });
  const res = act(s, { type: 'PICKUP', seat: 0, turnSeq: 1 });

  assert.equal(findEvent(res, 'pickedUp').count, 3);
  assert.deepEqual(ids(s.players[0].hand), ['9S', 'KD', '4H', '5H', '6H', '7H']);
  assert.deepEqual(ids(s.pile), []);
  assert.equal(s.current, 1, 'turn ends immediately');
});

test('picking up does not draw you back up to three', () => {
  const s = makeState({
    hands: ['9S', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '5H',
    stock: 'JH JS JD',
    current: 0,
  });
  const before = s.stock.length;
  const res = act(s, { type: 'PICKUP', seat: 0, turnSeq: 1 });
  assert.equal(findEvent(res, 'drew'), undefined, 'no draw event');
  assert.equal(s.stock.length, before, 'stock untouched');
  assert.equal(s.players[0].hand.length, 2);
});

test('you may pick up even when you hold a perfectly legal card', () => {
  const s = makeState({
    hands: ['AS KD 4H', '4C 5C 6C'],
    faceUp: ['AH 7S AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '5H',
    stock: 'JH JS JD',
    current: 0,
  });
  act(s, { type: 'PICKUP', seat: 0, turnSeq: 1 });
  assert.equal(s.players[0].hand.length, 4);
});

test('picking up an empty pile is rejected', () => {
  const s = makeState({
    hands: ['9S KD 4H', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '',
    stock: 'JH JS JD',
    current: 0,
  });
  rejects(s, { type: 'PICKUP', seat: 0, turnSeq: 1 }, ERR.EMPTY_PILE);
});

test('picking up out of turn or on a stale sequence is rejected', () => {
  const s = makeState({
    hands: ['9S KD 4H', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '5H',
    stock: 'JH JS JD',
    current: 0,
  });
  rejects(s, { type: 'PICKUP', seat: 1, turnSeq: 1 }, ERR.NOT_YOUR_TURN);
  rejects(s, { type: 'PICKUP', seat: 0, turnSeq: 99 }, ERR.STALE);
});

test('picking up while playing face-up cards re-locks them behind the new hand', () => {
  const s = makeState({
    hands: ['', '4C 5C 6C'],
    faceUp: ['3H 4D 5S', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: 'KH KD',
    stock: '',
    current: 0,
  });
  assert.equal(activeZone(s.players[0]), 'faceUp');
  act(s, { type: 'PICKUP', seat: 0, turnSeq: 1 });
  assert.equal(activeZone(s.players[0]), 'hand', 'face-up cards are locked again');
  assert.deepEqual(ids(s.players[0].hand), ['KH', 'KD']);
  assert.deepEqual(ids(s.players[0].faceUp), ['3H', '4D', '5S']);
});

test('a twenty-card pile lands in hand intact', () => {
  const s = makeState({
    hands: ['2H', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '2S 2D 2C'],
    pile: '3H 4H 5H 6H 7H 8H 9H 10H JH KH 3S 4S 5S 6S 7S 8S 9S 10S JS KS',
    stock: '',
    current: 0,
  });
  act(s, { type: 'PICKUP', seat: 0, turnSeq: 1 });
  assert.equal(s.players[0].hand.length, 21);
  assert.deepEqual(ids(s.pile), []);
});
