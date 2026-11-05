import test from 'node:test';
import assert from 'node:assert/strict';
import { makeState, act, ids, findEvent, turnEvent, eventKinds } from './helpers.js';

// ------------------------------------------------------------------ twos
// A 2 grants another turn WITHOUT burning. This is the rule most likely to be
// implemented wrong by conflating "extra turn" with "burn".

test('a 2 keeps your turn and leaves the pile intact', () => {
  const s = makeState({
    hands: ['2H 3S 9D', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: 'KD 5H',
    stock: 'JH JS JD JC',
    current: 0,
  });
  const burnedBefore = s.burned.length;
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['2H'], turnSeq: 1 });

  assert.deepEqual(ids(s.pile), ['KD', '5H', '2H'], 'pile survives, 2 on top');
  assert.equal(s.burned.length, burnedBefore, 'nothing was burned');
  assert.equal(s.current, 0, 'still your turn');
  assert.equal(turnEvent(res).extra, true);
  assert.equal(turnEvent(res).extraReason, 'two');
  assert.equal(findEvent(res, 'burned'), undefined);
});

test('after a 2 the follow-up play may be any card, including the lowest', () => {
  const s = makeState({
    hands: ['2H 3S 9D', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: 'AC',
    stock: 'JH JS JD JC',
    current: 0,
  });
  act(s, { type: 'PLAY', seat: 0, cardIds: ['2H'], turnSeq: 1 });
  act(s, { type: 'PLAY', seat: 0, cardIds: ['3S'], turnSeq: s.turnSeq });
  assert.deepEqual(ids(s.pile), ['AC', '2H', '3S']);
  assert.equal(s.current, 1, 'the ordinary follow-up ends the turn');
});

test('playing a 2 from hand refills to three BEFORE the follow-up turn', () => {
  const s = makeState({
    hands: ['2H', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: 'KD',
    stock: 'JH JS JD',
    current: 0,
  });
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['2H'], turnSeq: 1 });

  assert.equal(findEvent(res, 'drew').count, 3);
  assert.equal(s.players[0].hand.length, 3, 'full hand for the follow-up');
  assert.equal(s.current, 0, 'and it is still your turn');
  // the draw must be emitted before the turn event the client animates
  const kinds = eventKinds(res);
  assert.ok(kinds.indexOf('drew') < kinds.indexOf('turn'));
});

test('playing a 10 from hand also refills before the follow-up turn', () => {
  const s = makeState({
    hands: ['10H', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: 'KD',
    stock: 'JH JS JD',
    current: 0,
  });
  act(s, { type: 'PLAY', seat: 0, cardIds: ['10H'], turnSeq: 1 });
  assert.equal(s.players[0].hand.length, 3);
  assert.equal(s.current, 0);
  assert.deepEqual(ids(s.pile), [], 'the 10 burned the pile');
});

test('several 2s at once grant exactly one extra turn', () => {
  const s = makeState({
    hands: ['2H 2S 2D', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: 'KD',
    stock: 'JH JS JD JC',
    current: 0,
  });
  const burnedBefore = s.burned.length;
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['2H', '2S', '2D'], turnSeq: 1 });
  assert.equal(s.current, 0);
  assert.equal(res.events.filter((e) => e.e === 'turn').length, 1, 'one turn event only');
  assert.equal(s.burned.length, burnedBefore, 'three 2s do not burn');
  assert.deepEqual(ids(s.pile), ['KD', '2H', '2S', '2D']);
});

test('chained 2s terminate and do not deadlock', () => {
  const s = makeState({
    hands: ['2H 2S 2D', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: 'KD',
    stock: '9H 9S 9D',
    current: 0,
  });
  act(s, { type: 'PLAY', seat: 0, cardIds: ['2H'], turnSeq: s.turnSeq });
  act(s, { type: 'PLAY', seat: 0, cardIds: ['2S'], turnSeq: s.turnSeq });
  act(s, { type: 'PLAY', seat: 0, cardIds: ['2D'], turnSeq: s.turnSeq });
  assert.equal(s.current, 0, 'three 2s, three extra turns');
  act(s, { type: 'PLAY', seat: 0, cardIds: ['9H'], turnSeq: s.turnSeq });
  assert.equal(s.current, 1, 'an ordinary card finally passes it on');
});

test('a 2 played onto an empty pile still grants the extra turn', () => {
  const s = makeState({
    hands: ['2H 9S KD', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '',
    stock: 'JH JS JD JC',
    current: 0,
  });
  act(s, { type: 'PLAY', seat: 0, cardIds: ['2H'], turnSeq: 1 });
  assert.equal(s.current, 0);
  assert.deepEqual(ids(s.pile), ['2H']);
});

// ------------------------------------------------------------------ tens

test('a 10 burns the pile out of the game and keeps the turn', () => {
  const s = makeState({
    hands: ['10H 9S KD', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: 'KS 5H 6H',
    stock: 'JH JS JD JC',
    current: 0,
  });
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['10H'], turnSeq: 1 });

  assert.deepEqual(ids(s.pile), []);
  assert.equal(findEvent(res, 'burned').count, 4, 'three cards plus the 10');
  assert.equal(findEvent(res, 'burned').reason, 'ten');
  assert.ok(['KS', '5H', '6H', '10H'].every((id) => ids(s.burned).includes(id)));
  assert.equal(s.current, 0);
  assert.equal(turnEvent(res).extraReason, 'ten');
});

test('two 10s at once burn once and grant one extra turn', () => {
  const s = makeState({
    hands: ['10H 10S KD', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: 'KS',
    stock: 'JH JS JD JC',
    current: 0,
  });
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['10H', '10S'], turnSeq: 1 });
  assert.equal(res.events.filter((e) => e.e === 'burned').length, 1);
  assert.equal(res.events.filter((e) => e.e === 'turn').length, 1);
  assert.equal(s.current, 0);
});

test('a 10 is playable on anything', () => {
  const s = makeState({
    hands: ['10H 9S KD', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '2C',
    stock: 'JH JS JD JC',
    current: 0,
  });
  act(s, { type: 'PLAY', seat: 0, cardIds: ['10H'], turnSeq: 1 });
  assert.deepEqual(ids(s.pile), []);
});

// ------------------------------------------------------------- four of a kind

test('four of a kind played at once burns the pile', () => {
  const s = makeState({
    hands: ['7H 7S 7D 7C', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 8C 9C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '5H',
    stock: 'JH JS JD',
    current: 0,
  });
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['7H', '7S', '7D', '7C'], turnSeq: 1 });
  assert.equal(findEvent(res, 'burned').reason, 'fourOfAKind');
  assert.deepEqual(ids(s.pile), []);
  assert.equal(s.current, 0);
});

test('a bomb accumulated across turns burns for whoever lands the fourth card', () => {
  const s = makeState({
    hands: ['7H 9S KD', '7C 5C 6C'],
    faceUp: ['AH AS AD', '3D 8C 9C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '7D 7S',
    stock: 'JH JS JD JC',
    current: 0,
  });
  // seat 0 makes it three
  act(s, { type: 'PLAY', seat: 0, cardIds: ['7H'], turnSeq: s.turnSeq });
  assert.equal(s.pile.length, 3);
  assert.equal(s.current, 1);

  // seat 1 lands the fourth and gets the extra turn
  const res = act(s, { type: 'PLAY', seat: 1, cardIds: ['7C'], turnSeq: s.turnSeq });
  assert.equal(findEvent(res, 'burned').reason, 'fourOfAKind');
  assert.equal(s.current, 1, 'the player who completed it goes again');
});

test('a multi-card play that completes a bomb burns', () => {
  const s = makeState({
    hands: ['7H 7S 9D', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 8C 9C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: '7D 7C',
    stock: 'JH JS JD JC',
    current: 0,
  });
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['7H', '7S'], turnSeq: 1 });
  assert.equal(findEvent(res, 'burned').reason, 'fourOfAKind');
  assert.deepEqual(ids(s.pile), []);
  assert.equal(s.current, 0);
});

test('7,7,7,8 does not burn — the top four must match', () => {
  const s = makeState({
    hands: ['8H 9S KD', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 8C 9C'],
    faceDown: ['QH QS QD', '8S 8D 7H'],
    pile: '7D 7S 7C',
    stock: 'JH JS JD JC',
    current: 0,
  });
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['8H'], turnSeq: 1 });
  assert.equal(findEvent(res, 'burned'), undefined);
  assert.equal(s.pile.length, 4);
  assert.equal(s.current, 1);
});

test('four 2s burn and grant exactly one extra turn', () => {
  const s = makeState({
    hands: ['2H 2S 2D 2C', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 8C 9C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: 'KD',
    stock: 'JH JS JD',
    current: 0,
  });
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['2H', '2S', '2D', '2C'], turnSeq: 1 });
  assert.equal(findEvent(res, 'burned').reason, 'fourOfAKind');
  assert.deepEqual(ids(s.pile), []);
  assert.equal(res.events.filter((e) => e.e === 'turn').length, 1);
  assert.equal(s.current, 0);
});

test('a burn leaves the pile empty for the next player when the burner goes out', () => {
  const s = makeState({
    hands: ['', '4C 5C 6C'],
    faceUp: ['10H', '3D 8C 9C'],
    faceDown: ['', '8H 8S 8D'],
    pile: 'KD 5H',
    stock: '',
    current: 0,
  });
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['10H'], turnSeq: 1 });
  assert.equal(findEvent(res, 'burned').reason, 'ten');
  assert.equal(findEvent(res, 'playerOut').seat, 0);
  assert.deepEqual(ids(s.pile), [], 'next player starts clean');
  // two players, one went out -> game over
  assert.equal(s.phase, 'gameover');
  assert.equal(s.loser, 1);
});

test('burned cards never return to the stock', () => {
  const s = makeState({
    hands: ['10H 9S KD', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3D 7C 8C'],
    faceDown: ['QH QS QD', '8H 8S 8D'],
    pile: 'KS 5H',
    stock: 'JH JS JD JC',
    current: 0,
  });
  const stockBefore = ids(s.stock).length;
  act(s, { type: 'PLAY', seat: 0, cardIds: ['10H'], turnSeq: 1 });
  assert.equal(s.stock.length, stockBefore - 1, 'only the draw-up removed stock');
  assert.ok(!ids(s.stock).includes('KS'));
});
