import test from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../src/game/engine.js';
import { makeState, act, rejects, ids, findEvent, turnEvent } from './helpers.js';

// Reaching the blind-flip phase requires hand, face-up and stock to all be empty.
const flipState = (faceDown, pile, other = '4C 5C 6C') => makeState({
  hands: ['', other],
  faceUp: ['', '3D 7C 8C'],
  faceDown: [faceDown, '8H 8S 8D'],
  pile,
  stock: '',
  current: 0,
});

test('a successful flip stays on the pile and passes the turn', () => {
  const s = flipState('KH QS QD', '5H');
  const res = act(s, { type: 'FLIP', seat: 0, index: 0, turnSeq: 1 });

  assert.equal(findEvent(res, 'flipped').card.id, 'KH');
  assert.ok(findEvent(res, 'flipSuccess'));
  assert.deepEqual(ids(s.pile), ['5H', 'KH']);
  assert.equal(s.players[0].faceDown.length, 2);
  assert.equal(s.current, 1);
});

test('a failed flip puts the flipped card first, then the pile, into hand', () => {
  const s = flipState('3H QS QD', 'KD 5H 9H');
  const res = act(s, { type: 'FLIP', seat: 0, index: 0, turnSeq: 1 });

  assert.equal(findEvent(res, 'flipFail').card.id, '3H');
  assert.equal(findEvent(res, 'flipFail').taken, 4, 'three pile cards plus the flip');
  assert.deepEqual(ids(s.players[0].hand), ['3H', 'KD', '5H', '9H']);
  assert.deepEqual(ids(s.pile), []);
  assert.equal(s.current, 1);
});

test('a flipped 10 burns and earns another flip', () => {
  const s = flipState('10H QS QD', 'KD 5H');
  const res = act(s, { type: 'FLIP', seat: 0, index: 0, turnSeq: 1 });

  assert.equal(findEvent(res, 'burned').reason, 'ten');
  assert.deepEqual(ids(s.pile), []);
  assert.equal(s.current, 0, 'flip again');
  assert.equal(turnEvent(res).extraReason, 'ten');
});

test('a flipped 2 earns another flip WITHOUT burning', () => {
  const s = flipState('2H QS QD', 'KD 5H');
  const burnedBefore = s.burned.length;
  const res = act(s, { type: 'FLIP', seat: 0, index: 0, turnSeq: 1 });

  assert.equal(findEvent(res, 'burned'), undefined, 'a 2 does not burn');
  assert.deepEqual(ids(s.pile), ['KD', '5H', '2H'], 'pile intact, 2 on top');
  assert.equal(s.burned.length, burnedBefore);
  assert.equal(s.current, 0, 'flip again');
  assert.equal(turnEvent(res).extraReason, 'two');
});

test('after a flipped 2, the next blind flip can never fail', () => {
  const s = flipState('2H 3S QD', 'KD');
  act(s, { type: 'FLIP', seat: 0, index: 0, turnSeq: s.turnSeq });
  // the 2 is on top, so even a 3 succeeds
  const res = act(s, { type: 'FLIP', seat: 0, index: 0, turnSeq: s.turnSeq });
  assert.ok(findEvent(res, 'flipSuccess'));
  assert.deepEqual(ids(s.pile), ['KD', '2H', '3S']);
});

test('a flip onto an empty pile always succeeds', () => {
  const s = flipState('3H QS QD', '');
  const res = act(s, { type: 'FLIP', seat: 0, index: 0, turnSeq: 1 });
  assert.ok(findEvent(res, 'flipSuccess'));
  assert.equal(findEvent(res, 'flipFail'), undefined);
});

test('three consecutive burning flips terminate instead of looping', () => {
  const s = makeState({
    hands: ['', '4C 5C 6C'],
    faceUp: ['', '3D 7C 8C'],
    faceDown: ['10H 10S 2H', '8H 8S 8D'],
    pile: 'KD',
    stock: '',
    current: 0,
  });
  act(s, { type: 'FLIP', seat: 0, index: 0, turnSeq: s.turnSeq });
  assert.equal(s.current, 0);
  act(s, { type: 'FLIP', seat: 0, index: 0, turnSeq: s.turnSeq });
  assert.equal(s.current, 0);
  const res = act(s, { type: 'FLIP', seat: 0, index: 0, turnSeq: s.turnSeq });
  // last card gone: out, and the extra turn is cancelled
  assert.equal(findEvent(res, 'playerOut').seat, 0);
  assert.equal(s.phase, 'gameover');
  assert.equal(s.loser, 1);
});

test('the final successful flip takes the player out', () => {
  const s = makeState({
    hands: ['', '4C 5C 6C'],
    faceUp: ['', '3D 7C 8C'],
    faceDown: ['KH', '8H 8S 8D'],
    pile: '5H',
    stock: '',
    current: 0,
  });
  const res = act(s, { type: 'FLIP', seat: 0, index: 0, turnSeq: 1 });
  assert.equal(findEvent(res, 'playerOut').place, 1);
  assert.equal(s.phase, 'gameover');
  assert.equal(s.loser, 1);
});

test('flipping is refused while you still hold hand or face-up cards', () => {
  const withHand = makeState({
    hands: ['9S KD 4H', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '5H',
    stock: 'JH JS JD',
    current: 0,
  });
  rejects(withHand, { type: 'FLIP', seat: 0, index: 0, turnSeq: 1 }, ERR.NOT_FLIP_TIME);

  const withFaceUp = makeState({
    hands: ['', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '5H',
    stock: '',
    current: 0,
  });
  rejects(withFaceUp, { type: 'FLIP', seat: 0, index: 0, turnSeq: 1 }, ERR.NOT_FLIP_TIME);
});

test('a bad flip index is rejected', () => {
  const s = flipState('KH QS', '5H');
  rejects(s, { type: 'FLIP', seat: 0, index: 5, turnSeq: 1 }, ERR.BAD_INDEX);
  rejects(s, { type: 'FLIP', seat: 0, index: -1, turnSeq: 1 }, ERR.BAD_INDEX);
});

test('the index chooses which physical card is flipped', () => {
  const s = flipState('KH QS AD', '5H');
  const res = act(s, { type: 'FLIP', seat: 0, index: 2, turnSeq: 1 });
  assert.equal(findEvent(res, 'flipped').card.id, 'AD');
  assert.deepEqual(ids(s.players[0].faceDown), ['KH', 'QS']);
});

test('you may pick up the pile instead of gambling on a blind flip', () => {
  const s = flipState('3H QS QD', 'KD 5H');
  act(s, { type: 'PICKUP', seat: 0, turnSeq: 1 });
  assert.deepEqual(ids(s.players[0].hand), ['KD', '5H']);
  assert.equal(s.players[0].faceDown.length, 3, 'face-down cards untouched');
});

test('a failed flip never draws, because the stock is empty by then', () => {
  const s = flipState('3H QS QD', 'KD');
  const res = act(s, { type: 'FLIP', seat: 0, index: 0, turnSeq: 1 });
  assert.equal(findEvent(res, 'drew'), undefined);
});
