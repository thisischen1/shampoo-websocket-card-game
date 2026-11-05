import test from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../src/game/engine.js';
import { makeState, act, rejects, ids, findEvent, turnEvent, eventKinds } from './helpers.js';

// Seat 0 is down to a single hand card; seats 1 and 2 are still well stocked, so
// the game must carry on after seat 0 goes out.
const lastCard = (card, pile) => makeState({
  hands: [card, '4C 5C 6C', '4D 5D 6D'],
  faceUp: ['', '3S 8S KS', '3C 8C KC'],
  faceDown: ['', '9S JS 10S', '9C JC QC'],
  pile,
  stock: '',
  current: 0,
});

test('playing your last card takes you out and passes the turn', () => {
  const s = lastCard('7H', '5H');
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['7H'], turnSeq: 1 });

  assert.equal(findEvent(res, 'playerOut').place, 1);
  assert.equal(s.players[0].out, true);
  assert.deepEqual(s.finishedOrder, [0]);
  assert.equal(s.current, 1);
  assert.equal(s.phase, 'playing');
});

test('a last-card 2 goes out and the extra turn is cancelled', () => {
  const s = lastCard('2H', 'KD');
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['2H'], turnSeq: 1 });

  assert.equal(findEvent(res, 'burned'), undefined, 'a 2 still does not burn');
  assert.deepEqual(ids(s.pile), ['KD', '2H']);
  assert.equal(findEvent(res, 'playerOut').seat, 0);
  assert.equal(turnEvent(res).extra, false, 'no extra turn for a player with no cards');
  assert.equal(turnEvent(res).extraReason, null);
  assert.equal(s.current, 1);
});

test('a last-card 10 burns, goes out, and the extra turn is cancelled', () => {
  const s = lastCard('10H', 'KD 5H');
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['10H'], turnSeq: 1 });

  assert.equal(findEvent(res, 'burned').reason, 'ten');
  assert.deepEqual(ids(s.pile), [], 'the next player inherits an empty pile');
  assert.equal(findEvent(res, 'playerOut').seat, 0);
  assert.equal(turnEvent(res).extra, false);
  assert.equal(s.current, 1);
});

test('a last-card bomb burns, goes out, and the extra turn is cancelled', () => {
  const s = lastCard('7H', '7D 7C 7S');
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['7H'], turnSeq: 1 });

  assert.equal(findEvent(res, 'burned').reason, 'fourOfAKind');
  assert.deepEqual(ids(s.pile), []);
  assert.equal(findEvent(res, 'playerOut').seat, 0);
  assert.equal(turnEvent(res).extra, false);
  assert.equal(s.current, 1);
});

test('the out-check runs after the draw-up, so a refill keeps you in the game', () => {
  const s = makeState({
    hands: ['7H', '4C 5C 6C'],
    faceUp: ['', '3S 7S 8S'],
    faceDown: ['', '9S JS 10S'],
    pile: '5H',
    stock: 'JH',
    current: 0,
  });
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['7H'], turnSeq: 1 });

  assert.deepEqual(eventKinds(res), ['played', 'drew', 'turn'], 'drew, then no playerOut');
  assert.deepEqual(ids(s.players[0].hand), ['JH']);
  assert.equal(s.players[0].out, false);
  assert.equal(s.phase, 'playing');
});

test('a two-player game ends the instant one player goes out', () => {
  const s = makeState({
    hands: ['7H', '4C 5C 6C'],
    faceUp: ['', '3S 7S 8S'],
    faceDown: ['', '9S JS 10S'],
    pile: '5H',
    stock: '',
    current: 0,
  });
  const res = act(s, { type: 'PLAY', seat: 0, cardIds: ['7H'], turnSeq: 1 });

  assert.equal(findEvent(res, 'gameOver').loser, 1);
  assert.deepEqual(findEvent(res, 'gameOver').order, [0]);
  assert.equal(s.phase, 'gameover');
  assert.equal(s.loser, 1);
  assert.equal(s.players[1].out, false, 'the loser is still holding cards');
  assert.equal(findEvent(res, 'turn'), undefined, 'no turn is handed out after game over');
});

test('a five-player game records the full finishing order and one loser', () => {
  const s = makeState({
    hands: ['3H', '4H', '5H', '6H', '7H'],
    faceUp: ['', '', '', '', ''],
    faceDown: ['', '', '', '', ''],
    pile: '',
    stock: '',
    current: 0,
  });

  act(s, { type: 'PLAY', seat: 0, cardIds: ['3H'], turnSeq: s.turnSeq });
  act(s, { type: 'PLAY', seat: 1, cardIds: ['4H'], turnSeq: s.turnSeq });
  act(s, { type: 'PLAY', seat: 2, cardIds: ['5H'], turnSeq: s.turnSeq });
  const res = act(s, { type: 'PLAY', seat: 3, cardIds: ['6H'], turnSeq: s.turnSeq });

  assert.deepEqual(s.finishedOrder, [0, 1, 2, 3]);
  assert.deepEqual([1, 2, 3, 4], [0, 1, 2, 3].map((seat) => s.players[seat].place));
  assert.equal(findEvent(res, 'gameOver').loser, 4);
  assert.equal(s.loser, 4);
  assert.equal(s.players[4].place, null, 'the loser has no placement');
});

test('out players are skipped in the rotation', () => {
  const s = makeState({
    hands: ['7H 8H 9H', '', '8D 9D JD'],
    faceUp: ['AH AS AD', '', '3C 7C 8C'],
    faceDown: ['QH QS QD', '', '9C JC QC'],
    pile: '5H',
    stock: '',
    current: 0,
  });
  assert.equal(s.players[1].out, true);
  act(s, { type: 'PLAY', seat: 0, cardIds: ['7H'], turnSeq: 1 });
  assert.equal(s.current, 2);
  act(s, { type: 'PLAY', seat: 2, cardIds: ['8D'], turnSeq: s.turnSeq });
  assert.equal(s.current, 0, 'and wraps back past seat 1');
});

test('an out player cannot act', () => {
  const s = makeState({
    hands: ['7H 8H 9H', '', '8D 9D JD'],
    faceUp: ['AH AS AD', '', '3C 7C 8C'],
    faceDown: ['QH QS QD', '', '9C JC QC'],
    pile: '5H',
    stock: '',
    current: 0,
  });
  rejects(s, { type: 'PLAY', seat: 1, cardIds: ['7H'], turnSeq: 1 }, ERR.PLAYER_OUT);
  rejects(s, { type: 'PICKUP', seat: 1, turnSeq: 1 }, ERR.PLAYER_OUT);
  rejects(s, { type: 'FLIP', seat: 1, index: 0, turnSeq: 1 }, ERR.PLAYER_OUT);
});

test('nothing can be played once the game is over', () => {
  const s = makeState({
    hands: ['7H', '4C 5C 6C'],
    faceUp: ['', '3S 7S 8S'],
    faceDown: ['', '9S JS 10S'],
    pile: '5H',
    stock: '',
    current: 0,
  });
  act(s, { type: 'PLAY', seat: 0, cardIds: ['7H'], turnSeq: 1 });

  rejects(s, { type: 'PLAY', seat: 1, cardIds: ['6C'], turnSeq: s.turnSeq }, ERR.WRONG_PHASE);
  rejects(s, { type: 'PICKUP', seat: 1, turnSeq: s.turnSeq }, ERR.WRONG_PHASE);
  rejects(s, { type: 'FLIP', seat: 1, index: 0, turnSeq: s.turnSeq }, ERR.WRONG_PHASE);
  rejects(s, { type: 'FORFEIT', seat: 1 }, ERR.WRONG_PHASE);
});

test('a forfeit sends every card out of play and can end the game', () => {
  const s = makeState({
    hands: ['7H 8H 9H', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3S 7S 8S'],
    faceDown: ['QH QS QD', '9S JS 10S'],
    pile: '5H',
    stock: '',
    current: 0,
  });
  const burnedBefore = s.burned.length;
  const res = act(s, { type: 'FORFEIT', seat: 0 });

  assert.equal(findEvent(res, 'forfeit').seat, 0);
  assert.equal(s.burned.length, burnedBefore + 9, 'all nine cards are out of play');
  assert.equal(s.players[0].forfeited, true);
  assert.equal(s.players[0].out, true);
  assert.equal(s.phase, 'gameover');
  assert.equal(s.loser, 1);
});

test('forfeiting the current seat hands the turn on without ending a bigger game', () => {
  const s = makeState({
    hands: ['7H 8H 9H', '4C 5C 6C', '4D 5D 6D'],
    faceUp: ['AH AS AD', '3S 7S 8S', '3C 7C 8C'],
    faceDown: ['QH QS QD', '9S JS 10S', '9C JC QC'],
    pile: '5H',
    stock: '',
    current: 0,
  });
  const res = act(s, { type: 'FORFEIT', seat: 0 });
  assert.equal(s.phase, 'playing');
  assert.equal(s.current, 1);
  assert.equal(turnEvent(res).seat, 1);

  // forfeiting a seat that is not on turn leaves the turn alone
  const other = act(s, { type: 'FORFEIT', seat: 2 });
  assert.equal(s.current, 1);
  assert.equal(s.phase, 'gameover');
  assert.equal(findEvent(other, 'gameOver').loser, 1);
});

test('a seat cannot be forfeited twice', () => {
  const s = makeState({
    hands: ['7H 8H 9H', '4C 5C 6C', '4D 5D 6D'],
    faceUp: ['AH AS AD', '3S 7S 8S', '3C 7C 8C'],
    faceDown: ['QH QS QD', '9S JS 10S', '9C JC QC'],
    pile: '5H',
    stock: '',
    current: 0,
  });
  act(s, { type: 'FORFEIT', seat: 2 });
  rejects(s, { type: 'FORFEIT', seat: 2 }, ERR.PLAYER_OUT);
});

test('going out on a failed last flip is impossible — you take the pile instead', () => {
  const s = makeState({
    hands: ['', '4C 5C 6C'],
    faceUp: ['', '3S 7S 8S'],
    faceDown: ['3H', '9S JS 10S'],
    pile: 'KD 5H',
    stock: '',
    current: 0,
  });
  const res = act(s, { type: 'FLIP', seat: 0, index: 0, turnSeq: 1 });

  assert.equal(findEvent(res, 'playerOut'), undefined);
  assert.deepEqual(ids(s.players[0].hand), ['3H', 'KD', '5H']);
  assert.equal(s.phase, 'playing');
  assert.equal(s.current, 1);
});

test('the turn sequence only ever moves forward', () => {
  const s = makeState({
    hands: ['2H 7H 9H', '4C 5C 6C'],
    faceUp: ['AH AS AD', '3S 7S 8S'],
    faceDown: ['QH QS QD', '9S JS 10S'],
    pile: '5H',
    stock: '',
    current: 0,
  });
  const seen = [s.turnSeq];
  act(s, { type: 'PLAY', seat: 0, cardIds: ['2H'], turnSeq: s.turnSeq });
  seen.push(s.turnSeq);
  act(s, { type: 'PLAY', seat: 0, cardIds: ['7H'], turnSeq: s.turnSeq });
  seen.push(s.turnSeq);
  act(s, { type: 'PICKUP', seat: 1, turnSeq: s.turnSeq });
  seen.push(s.turnSeq);

  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] > seen[i - 1], `turnSeq ${seen[i]} must exceed ${seen[i - 1]}`);
  }
});
